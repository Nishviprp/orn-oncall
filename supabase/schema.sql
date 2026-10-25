-- ORN Global – ON CALL, multi-hospital edition (Stage 1)
-- Run in Supabase: Dashboard → SQL Editor → New query → paste → Run. Safe to run again.
--
-- Structure:  organization → hospital (state, time zone) → department (its own call rules) → staff
-- Every rule a department uses (call times, number of calls, shifts, who can take what, groups,
-- period length, minimum hours, sign-up window, reminders) is stored here and edited in the app.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ---------- places ----------

create table if not exists public.oc_orgs (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(trim(name)) between 2 and 120),
  created_at  timestamptz not null default now()
);

create table if not exists public.oc_hospitals (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references public.oc_orgs(id) on delete restrict,
  name        text not null check (char_length(trim(name)) between 2 and 120),
  state       text not null check (state ~ '^[A-Z]{2}$'),        -- US state / territory code
  city        text check (city is null or char_length(city) <= 80),
  timezone    text not null default 'America/New_York',
  created_at  timestamptz not null default now()
);

create table if not exists public.oc_departments (
  id                     uuid primary key default gen_random_uuid(),
  hospital_id            uuid not null references public.oc_hospitals(id) on delete restrict,
  name                   text not null check (char_length(trim(name)) between 2 and 120),
  active                 boolean not null default true,
  -- sign-up periods
  use_periods            boolean not null default true,      -- false = sign up any time, up to book_weeks_ahead
  period_weeks           int not null default 6 check (period_weeks between 1 and 26),
  min_hours              numeric(6,1) not null default 24 check (min_hours >= 0 and min_hours <= 2000),
  groups                 text[] not null default '{A,B}',    -- empty = no groups; order = default sign-up order
  group_gap_days         int not null default 1 check (group_gap_days between 0 and 14),
  signup_open_time       time not null default '08:00',
  signup_close_days      int not null default 0 check (signup_close_days between 0 and 30), -- days after last group opens; closes at end of that day
  book_weeks_ahead       int not null default 8 check (book_weeks_ahead between 1 and 52),  -- when use_periods = false
  vacancy_open_days      int not null default 7 check (vacancy_open_days between 0 and 60), -- when use_periods = false
  -- changes and reminders
  cancel_cutoff_hours    int not null default 24 check (cancel_cutoff_hours between 0 and 720),
  day_reminder_hour      int not null default 8 check (day_reminder_hour between 0 and 23),
  hour_reminder_minutes  int not null default 60 check (hour_reminder_minutes between 0 and 1440),
  switch_needs_approval  boolean not null default true,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  check (cardinality(groups) <= 6)
);

-- Call times (e.g. 3–7 PM). end_time <= start_time means it ends the next day (start = end → 24 h).
create table if not exists public.oc_blocks (
  id             uuid primary key default gen_random_uuid(),
  department_id  uuid not null references public.oc_departments(id) on delete cascade,
  label          text not null check (char_length(trim(label)) between 1 and 40),
  start_time     time not null,
  end_time       time not null,
  days           int[] not null default '{1,2,3,4,5,6}' check (cardinality(days) between 1 and 7 and days <@ array[1,2,3,4,5,6,7]),  -- ISO: 1 = Monday … 7 = Sunday
  levels         int not null default 1 check (levels between 1 and 3),   -- 1 = first call only, 2 = + second, 3 = + third
  sort           int not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Staff shift types (e.g. 7a–3p). Used to decide who can take which call.
create table if not exists public.oc_shifts (
  id             uuid primary key default gen_random_uuid(),
  department_id  uuid not null references public.oc_departments(id) on delete cascade,
  name           text not null check (char_length(trim(name)) between 1 and 40),
  sort           int not null default 0,
  active         boolean not null default true,
  created_at     timestamptz not null default now()
);

-- Who can take each call time. No row = cannot take it.
--   signup      = can sign up as soon as their sign-up opens
--   after_close = can take open slots only after sign-up closes (vacancies)
create table if not exists public.oc_block_rules (
  block_id  uuid not null references public.oc_blocks(id) on delete cascade,
  shift_id  uuid not null references public.oc_shifts(id) on delete cascade,
  access    text not null check (access in ('signup', 'after_close')),
  primary key (block_id, shift_id)
);

-- ---------- people ----------

-- One profile per signed-in person (name shown everywhere).
create table if not exists public.oc_profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null check (char_length(trim(full_name)) between 2 and 100),
  email       text,
  phone       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Department staff list. A person can be in several departments (matched by email or phone).
create table if not exists public.oc_members (
  id             uuid primary key default gen_random_uuid(),
  department_id  uuid not null references public.oc_departments(id) on delete cascade,
  full_name      text not null check (char_length(trim(full_name)) between 2 and 100),
  email          text check (email is null or email = lower(email)),
  phone          text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  is_manager     boolean not null default false,
  group_name     text,
  shift_id       uuid references public.oc_shifts(id) on delete set null,
  created_at     timestamptz not null default now(),
  unique (department_id, email),
  unique (department_id, phone)
);
create index if not exists oc_members_email on public.oc_members (email);
create index if not exists oc_members_phone on public.oc_members (phone);

-- Administrators: system (everything), organization, or hospital.
create table if not exists public.oc_admins (
  id           uuid primary key default gen_random_uuid(),
  scope        text not null check (scope in ('system', 'org', 'hospital')),
  org_id       uuid references public.oc_orgs(id) on delete cascade,
  hospital_id  uuid references public.oc_hospitals(id) on delete cascade,
  full_name    text,
  email        text check (email is null or email = lower(email)),
  phone        text check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$'),
  created_at   timestamptz not null default now(),
  check (email is not null or phone is not null),
  check ((scope = 'system' and org_id is null and hospital_id is null)
      or (scope = 'org' and org_id is not null and hospital_id is null)
      or (scope = 'hospital' and hospital_id is not null and org_id is null))
);
create index if not exists oc_admins_email on public.oc_admins (email);
create index if not exists oc_admins_phone on public.oc_admins (phone);

-- ---------- schedule ----------

create table if not exists public.oc_periods (
  id                     uuid primary key default gen_random_uuid(),
  department_id          uuid not null references public.oc_departments(id) on delete cascade,
  start_date             date not null,
  end_date               date not null,
  signup_start           date not null,
  group_order            text[] not null default '{}',     -- who signs up first, second…; empty = everyone at once
  opens_at               timestamptz[] not null,            -- one per group (or one for everyone)
  closes_at              timestamptz not null,
  notified_count         int not null default 0,            -- how many "sign-up is open" notices have gone out
  vacancy_notice_sent_at timestamptz,
  created_by             uuid references auth.users(id) on delete set null,
  created_at             timestamptz not null default now(),
  unique (department_id, start_date),
  check (end_date >= start_date),
  check (cardinality(opens_at) >= 1),
  check (cardinality(group_order) = 0 or cardinality(group_order) = cardinality(opens_at))
);

create table if not exists public.oc_signups (
  id                     uuid primary key default gen_random_uuid(),
  department_id          uuid not null references public.oc_departments(id) on delete cascade,
  block_id               uuid not null references public.oc_blocks(id) on delete restrict,
  user_id                uuid not null references auth.users(id) on delete cascade,
  shift_date             date not null,
  level                  int not null check (level between 1 and 3),
  block_label            text not null,                    -- copy of the call time's name when signed up
  start_at               timestamptz not null,
  end_at                 timestamptz not null,
  hours                  numeric(5,2) not null,
  day_reminder_sent_at   timestamptz,
  hour_reminder_sent_at  timestamptz,
  stay_status            text check (stay_status in ('stay', 'released')),
  stay_note              text check (stay_note is null or char_length(stay_note) <= 300),
  stay_notified_at       timestamptz,
  created_at             timestamptz not null default now(),
  check (end_at > start_at),
  -- One nurse per slot.
  constraint oc_one_nurse_per_slot unique (block_id, shift_date, level),
  -- No one can hold two calls whose times overlap (in any department).
  constraint oc_no_overlapping_calls exclude using gist (user_id with =, tstzrange(start_at, end_at) with &&)
);
create index if not exists oc_signups_dept_date on public.oc_signups (department_id, shift_date);
create index if not exists oc_signups_user_start on public.oc_signups (user_id, start_at);
create index if not exists oc_signups_start on public.oc_signups (start_at);

create table if not exists public.oc_swaps (
  id                    uuid primary key default gen_random_uuid(),
  department_id         uuid not null references public.oc_departments(id) on delete cascade,
  signup_id             uuid not null references public.oc_signups(id) on delete cascade,
  from_user             uuid not null references auth.users(id) on delete cascade,
  to_user               uuid not null references auth.users(id) on delete cascade,
  status                text not null default 'pending_colleague'
                        check (status in ('pending_colleague', 'pending_manager', 'approved', 'declined', 'denied', 'cancelled', 'expired')),
  note                  text check (note is null or char_length(note) <= 300),
  shift_date            date not null,
  block_id              uuid not null,
  level                 int not null,
  block_label           text not null,
  start_at              timestamptz not null,
  end_at                timestamptz not null,
  colleague_response_at timestamptz,
  manager_id            uuid references auth.users(id) on delete set null,
  manager_response_at   timestamptz,
  manager_note          text check (manager_note is null or char_length(manager_note) <= 300),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  check (from_user <> to_user)
);
create unique index if not exists oc_one_open_swap_per_call
  on public.oc_swaps (signup_id) where status in ('pending_colleague', 'pending_manager');
create index if not exists oc_swaps_to_user on public.oc_swaps (to_user, status);
create index if not exists oc_swaps_from_user on public.oc_swaps (from_user, status);
create index if not exists oc_swaps_dept_status on public.oc_swaps (department_id, status, start_at);

-- Approval moves the call to the colleague in ONE step (all or nothing).
-- p_manager may be null when the department doesn't require manager approval.
create or replace function public.oc_approve_swap(
  p_swap uuid, p_manager uuid, p_day_sent timestamptz, p_hour_sent timestamptz
) returns public.oc_swaps
language plpgsql security definer set search_path = public as $$
declare
  s public.oc_swaps;
begin
  select * into s from public.oc_swaps where id = p_swap for update;
  if not found then raise exception 'SWAP_NOT_FOUND'; end if;
  if s.status not in ('pending_manager', 'pending_colleague') then raise exception 'SWAP_NOT_PENDING'; end if;
  if s.status = 'pending_colleague' and p_manager is not null then raise exception 'SWAP_NOT_PENDING'; end if;

  update public.oc_signups
     set user_id = s.to_user,
         day_reminder_sent_at = p_day_sent,
         hour_reminder_sent_at = p_hour_sent,
         stay_status = null, stay_note = null, stay_notified_at = null
   where id = s.signup_id and user_id = s.from_user and start_at > now();
  if not found then raise exception 'SIGNUP_CHANGED'; end if;

  update public.oc_swaps
     set status = 'approved', manager_id = p_manager, manager_response_at = case when p_manager is null then null else now() end,
         colleague_response_at = coalesce(colleague_response_at, now()), updated_at = now()
   where id = p_swap
  returning * into s;
  return s;
end;
$$;

revoke all on function public.oc_approve_swap(uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function public.oc_approve_swap(uuid, uuid, timestamptz, timestamptz) from anon, authenticated;
grant execute on function public.oc_approve_swap(uuid, uuid, timestamptz, timestamptz) to service_role;

-- ---------- security ----------
-- Row-level security on, with NO policies: the browser can read or change nothing directly.
-- All access goes through the server (service role key), which checks every request.
alter table public.oc_orgs        enable row level security;
alter table public.oc_hospitals   enable row level security;
alter table public.oc_departments enable row level security;
alter table public.oc_blocks      enable row level security;
alter table public.oc_shifts      enable row level security;
alter table public.oc_block_rules enable row level security;
alter table public.oc_profiles    enable row level security;
alter table public.oc_members     enable row level security;
alter table public.oc_admins      enable row level security;
alter table public.oc_periods     enable row level security;
alter table public.oc_signups     enable row level security;
alter table public.oc_swaps       enable row level security;

-- ---------- first administrator ----------
-- Edit and run once, so you can sign in and open the Admin tab:
-- insert into public.oc_admins (scope, full_name, email) values ('system', 'Your Name', 'you@example.com');
