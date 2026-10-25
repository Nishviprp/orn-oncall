-- ONLY if you already ran the earlier single-department version (tables named oncall_*).
-- Moves its staff, periods, sign-ups, switches and profiles into the new multi-hospital tables
-- as one department. Run AFTER schema.sql. The old tables are left untouched (delete them later
-- once you're happy).
--
-- 1) Edit the four names below.  2) Run once.

do $$
declare
  v_org_name   text := 'My Health System';     -- organization (health system)
  v_hosp_name  text := 'My Hospital';          -- hospital
  v_hosp_state text := 'NJ';                   -- two-letter state
  v_dept_name  text := 'OR';                   -- department
  v_org uuid; v_hosp uuid; v_dept uuid;
  v_early uuid; v_late uuid; v_day uuid; v_mid uuid;
begin
  if to_regclass('public.oncall_signups') is null then
    raise exception 'No earlier ON CALL tables found – nothing to migrate.';
  end if;
  if exists (select 1 from public.oc_departments d join public.oc_hospitals h on h.id = d.hospital_id
             where d.name = v_dept_name and h.name = v_hosp_name) then
    raise exception 'Already migrated: % at % exists.', v_dept_name, v_hosp_name;
  end if;

  insert into public.oc_orgs (name) values (v_org_name) returning id into v_org;
  insert into public.oc_hospitals (org_id, name, state, timezone) values (v_org, v_hosp_name, v_hosp_state, 'America/New_York') returning id into v_hosp;
  insert into public.oc_departments (hospital_id, name, use_periods, period_weeks, min_hours, groups, group_gap_days, signup_open_time, signup_close_days)
    values (v_hosp, v_dept_name, true, 6, 24, '{A,B}', 1, '08:00', 0) returning id into v_dept;

  insert into public.oc_blocks (department_id, label, start_time, end_time, days, levels, sort)
    values (v_dept, '3–7 PM', '15:00', '19:00', '{1,2,3,4,5,6}', 2, 1) returning id into v_early;
  insert into public.oc_blocks (department_id, label, start_time, end_time, days, levels, sort)
    values (v_dept, '7–11 PM', '19:00', '23:00', '{1,2,3,4,5,6}', 1, 2) returning id into v_late;
  insert into public.oc_shifts (department_id, name, sort) values (v_dept, '7a–3p', 1) returning id into v_day;
  insert into public.oc_shifts (department_id, name, sort) values (v_dept, '11a–7p', 2) returning id into v_mid;
  insert into public.oc_block_rules (block_id, shift_id, access) values
    (v_early, v_day, 'signup'), (v_late, v_mid, 'signup'), (v_late, v_day, 'after_close');

  -- People
  insert into public.oc_profiles (id, full_name, email, phone, created_at, updated_at)
    select id, full_name, email, phone, created_at, updated_at from public.oncall_profiles
    on conflict (id) do nothing;
  insert into public.oc_members (department_id, full_name, email, phone, is_manager, group_name, shift_id)
    select v_dept, coalesce(nullif(trim(full_name), ''), email, phone, 'Staff member'), email, phone, is_manager, group_name,
           case shift when 'day' then v_day when 'mid' then v_mid end
    from public.oncall_allowlist;

  -- Periods
  insert into public.oc_periods (id, department_id, start_date, end_date, signup_start, group_order, opens_at, closes_at,
                                 notified_count, vacancy_notice_sent_at, created_by, created_at)
    select id, v_dept, start_date, end_date, signup_saturday,
           array[first_group, case first_group when 'A' then 'B' else 'A' end],
           array[first_opens_at, second_opens_at], closes_at,
           (first_notice_sent_at is not null)::int + (second_notice_sent_at is not null)::int,
           vacancy_notice_sent_at, created_by, created_at
    from public.oncall_periods;

  -- Sign-ups (same ids, so switches keep pointing at them)
  insert into public.oc_signups (id, department_id, block_id, user_id, shift_date, level, block_label, start_at, end_at, hours,
                                 day_reminder_sent_at, hour_reminder_sent_at, stay_status, stay_note, stay_notified_at, created_at)
    select s.id, v_dept, case s.block when 'early' then v_early else v_late end, s.user_id, s.shift_date,
           case s.role when 'primary' then 1 else 2 end,
           case s.block when 'early' then '3–7 PM' else '7–11 PM' end,
           s.start_at, s.end_at, round((extract(epoch from (s.end_at - s.start_at)) / 3600)::numeric, 2),
           s.day_reminder_sent_at, s.hour_reminder_sent_at, s.stay_status, s.stay_note, s.stay_notified_at, s.created_at
    from public.oncall_signups s;

  -- Switches
  insert into public.oc_swaps (id, department_id, signup_id, from_user, to_user, status, note, shift_date, block_id, level, block_label,
                               start_at, end_at, colleague_response_at, manager_id, manager_response_at, manager_note, created_at, updated_at)
    select w.id, v_dept, w.signup_id, w.from_user, w.to_user, w.status, w.note, w.shift_date,
           case w.block when 'early' then v_early else v_late end,
           case w.role when 'primary' then 1 else 2 end,
           case w.block when 'early' then '3–7 PM' else '7–11 PM' end,
           w.start_at, s.end_at, w.colleague_response_at, w.manager_id, w.manager_response_at, w.manager_note, w.created_at, w.updated_at
    from public.oncall_swaps w join public.oncall_signups s on s.id = w.signup_id;

  raise notice 'Migrated into department % (id %).', v_dept_name, v_dept;
end $$;
