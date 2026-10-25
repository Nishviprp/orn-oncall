-- ORN Global – ON CALL schedule
-- Run this in Supabase: Dashboard → SQL Editor → New query → paste → Run.
-- Safe to run again: it creates what is missing and upgrades older installs.

create extension if not exists pgcrypto;

-- 1. Nurse profiles (name shown on schedules and messages; contact copied from the sign-in account)
create table if not exists public.oncall_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null check (char_length(trim(full_name)) between 2 and 100),
  email       text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.oncall_profiles add column if not exists email text;
alter table public.oncall_profiles add column if not exists phone text;

-- 2. Staff list (managed on the Manage tab). Only people on this list can take call.
--    group_name: A or B (who signs up first rotates each 6-week period)
--    shift: day = 7a–3p staff (3–7 PM call, first or second call)
--           mid = 11a–7p staff (7–11 PM call, first call only)
--    is_manager: opens periods, approves switches, sends stay/released notices, manages staff.
create table if not exists public.oncall_allowlist (
  id          bigint generated always as identity primary key,
  full_name   text,
  email       text unique check (email is null or email = lower(email)),
  phone       text unique check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  is_manager  boolean not null default false,
  group_name  text check (group_name in ('A', 'B')),
  shift       text check (shift in ('day', 'mid')),
  created_at  timestamptz not null default now()
);
alter table public.oncall_allowlist add column if not exists group_name text check (group_name in ('A', 'B'));
alter table public.oncall_allowlist add column if not exists shift text check (shift in ('day', 'mid'));
-- Older installs required an email or phone; names can now be added first and contacts later.
alter table public.oncall_allowlist drop constraint if exists oncall_allowlist_check;

-- 3. Six-week call periods (opened by a manager).
create table if not exists public.oncall_periods (
  id                      uuid primary key default gen_random_uuid(),
  start_date              date not null unique,           -- a Monday
  end_date                date not null,                  -- the Sunday 6 weeks later
  first_group             text not null check (first_group in ('A', 'B')),
  signup_saturday         date not null,
  first_opens_at          timestamptz not null,           -- Saturday morning: first group
  second_opens_at         timestamptz not null,           -- Sunday morning: second group
  closes_at               timestamptz not null,           -- Sunday night: after this, open evening slots go to 7a–3p staff too
  first_notice_sent_at    timestamptz,
  second_notice_sent_at   timestamptz,
  vacancy_notice_sent_at  timestamptz,
  created_by              uuid references auth.users(id) on delete set null,
  created_at              timestamptz not null default now(),
  check (extract(isodow from start_date) = 1),
  check (extract(isodow from signup_saturday) = 6),
  check (end_date = start_date + 41),
  check (first_opens_at < second_opens_at and second_opens_at < closes_at)
);

-- 4. Call sign-ups
create table if not exists public.oncall_signups (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  shift_date             date not null,
  block                  text not null check (block in ('early', 'late')),        -- early = 3–7 PM, late = 7–11 PM
  role                   text not null check (role in ('primary', 'secondary')),  -- first call / second call
  start_at               timestamptz not null,
  end_at                 timestamptz not null,
  day_reminder_sent_at   timestamptz,
  hour_reminder_sent_at  timestamptz,
  stay_status            text check (stay_status in ('stay', 'released')),
  stay_note              text check (stay_note is null or char_length(stay_note) <= 300),
  stay_notified_at       timestamptz,
  created_at             timestamptz not null default now(),
  -- Once a slot is taken nobody else can take it (enforced by the database itself).
  constraint oncall_one_nurse_per_slot unique (shift_date, block, role),
  -- A nurse cannot be both first and second call for the same time.
  constraint oncall_one_role_per_nurse unique (shift_date, block, user_id),
  -- Monday (1) to Saturday (6) only.
  constraint oncall_mon_to_sat check (extract(isodow from shift_date) between 1 and 6)
);
alter table public.oncall_signups add column if not exists stay_status text check (stay_status in ('stay', 'released'));
alter table public.oncall_signups add column if not exists stay_note text check (stay_note is null or char_length(stay_note) <= 300);
alter table public.oncall_signups add column if not exists stay_notified_at timestamptz;

-- 7–11 PM has first call only.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'oncall_evening_first_call_only') then
    alter table public.oncall_signups
      add constraint oncall_evening_first_call_only check (block <> 'late' or role = 'primary');
  end if;
end $$;

create index if not exists oncall_signups_user_start on public.oncall_signups (user_id, start_at);
create index if not exists oncall_signups_hour_due on public.oncall_signups (start_at) where hour_reminder_sent_at is null;
create index if not exists oncall_signups_day_due on public.oncall_signups (shift_date) where day_reminder_sent_at is null;

-- 5. Call switches: a nurse gives a call to a colleague → colleague accepts → manager approves.
create table if not exists public.oncall_swaps (
  id                    uuid primary key default gen_random_uuid(),
  signup_id             uuid not null references public.oncall_signups(id) on delete cascade,
  from_user             uuid not null references auth.users(id) on delete cascade,
  to_user               uuid not null references auth.users(id) on delete cascade,
  -- pending_colleague → pending_manager → approved
  -- or: declined (by colleague), denied (by manager), cancelled (by requester), expired (call started)
  status                text not null default 'pending_colleague'
                        check (status in ('pending_colleague', 'pending_manager', 'approved', 'declined', 'denied', 'cancelled', 'expired')),
  note                  text check (note is null or char_length(note) <= 300),
  shift_date            date not null,
  block                 text not null,
  role                  text not null,
  start_at              timestamptz not null,
  colleague_response_at timestamptz,
  manager_id            uuid references auth.users(id) on delete set null,
  manager_response_at   timestamptz,
  manager_note          text check (manager_note is null or char_length(manager_note) <= 300),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (from_user <> to_user)
);

-- Only one open switch request per call at a time.
create unique index if not exists oncall_one_open_swap_per_call
  on public.oncall_swaps (signup_id) where status in ('pending_colleague', 'pending_manager');
create index if not exists oncall_swaps_to_user on public.oncall_swaps (to_user, status);
create index if not exists oncall_swaps_from_user on public.oncall_swaps (from_user, status);
create index if not exists oncall_swaps_status on public.oncall_swaps (status, start_at);

-- Manager approval moves the call to the colleague in ONE step (all or nothing).
create or replace function public.oncall_approve_swap(
  p_swap uuid, p_manager uuid, p_day_sent timestamptz, p_hour_sent timestamptz
) returns public.oncall_swaps
language plpgsql security definer set search_path = public as $$
declare
  s public.oncall_swaps;
begin
  select * into s from public.oncall_swaps where id = p_swap for update;
  if not found then raise exception 'SWAP_NOT_FOUND'; end if;
  if s.status <> 'pending_manager' then raise exception 'SWAP_NOT_PENDING'; end if;

  update public.oncall_signups
     set user_id = s.to_user,
         day_reminder_sent_at = p_day_sent,
         hour_reminder_sent_at = p_hour_sent,
         stay_status = null, stay_note = null, stay_notified_at = null
   where id = s.signup_id and user_id = s.from_user and start_at > now();
  if not found then raise exception 'SIGNUP_CHANGED'; end if;

  update public.oncall_swaps
     set status = 'approved', manager_id = p_manager, manager_response_at = now(), updated_at = now()
   where id = p_swap
  returning * into s;
  return s;
end;
$$;

revoke all on function public.oncall_approve_swap(uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function public.oncall_approve_swap(uuid, uuid, timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.oncall_approve_swap(uuid, uuid, timestamptz, timestamptz) to service_role;

-- Security: row-level security on, with NO policies.
-- The browser (anon key) can read or change nothing; only the server (service role key) can.
alter table public.oncall_profiles  enable row level security;
alter table public.oncall_allowlist enable row level security;
alter table public.oncall_periods   enable row level security;
alter table public.oncall_signups   enable row level security;
alter table public.oncall_swaps     enable row level security;

-- First manager (required so someone can sign in and open the Manage tab). Edit and run:
-- insert into public.oncall_allowlist (full_name, email, phone, is_manager) values
--   ('OR Manager', 'manager@example.com', null, true);
