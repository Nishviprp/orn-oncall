// Runs the real schema.sql in an in-memory PostgreSQL (PGlite) and checks the rules the
// database itself enforces.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const U = (n) => `00000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`;
const [A, B, C, M] = [U(1), U(2), U(3), U(9)];
let pg, dept1, dept2, early, late, other;

export async function freshDb() {
  const db = new PGlite({ extensions: { btree_gist } });
  await db.exec(`
    create schema auth;
    create table auth.users (id uuid primary key);
    create role anon; create role authenticated; create role service_role;
  `);
  return db;
}

const schemaText = async () => (await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', '');

const err = async (sql, params = []) => {
  try {
    await pg.query(sql, params);
  } catch (e) {
    return e;
  }
  return null;
};
const one = async (sql, params = []) => (await pg.query(sql, params)).rows[0];

before(async () => {
  pg = await freshDb();
  const schema = await schemaText();
  await pg.exec(schema);
  await pg.exec(schema); // running it twice must be safe
  await pg.exec(`insert into auth.users (id) values ('${A}'), ('${B}'), ('${C}'), ('${M}');`);
  const org = (await one(`insert into oc_orgs (name) values ('Health System') returning id`)).id;
  const hosp = (await one(`insert into oc_hospitals (org_id, name, state, timezone) values ($1, 'Morris', 'NJ', 'America/New_York') returning id`, [org])).id;
  dept1 = (await one(`insert into oc_departments (hospital_id, name) values ($1, 'OR') returning id`, [hosp])).id;
  dept2 = (await one(`insert into oc_departments (hospital_id, name, use_periods, groups) values ($1, 'Cath Lab', false, '{}') returning id`, [hosp])).id;
  early = (await one(`insert into oc_blocks (department_id, label, start_time, end_time, levels) values ($1, '3–7 PM', '15:00', '19:00', 2) returning id`, [dept1])).id;
  late = (await one(`insert into oc_blocks (department_id, label, start_time, end_time, levels) values ($1, '7–11 PM', '19:00', '23:00', 1) returning id`, [dept1])).id;
  other = (await one(`insert into oc_blocks (department_id, label, start_time, end_time, days, levels) values ($1, 'Evening', '17:00', '23:00', '{1,2,3,4,5,6,7}', 1) returning id`, [dept2])).id;
});

const at = (date, hhmm) => `${date}T${hhmm}:00-05:00`;
async function signup(user, block, dept, date, level, start, end) {
  return (await one(
    `insert into oc_signups (department_id, block_id, user_id, shift_date, level, block_label, start_at, end_at, hours)
     values ($1, $2, $3, $4, $5, 'x', $6, $7, 4) returning id`,
    [dept, block, user, date, level, at(date, start), at(date, end)],
  )).id;
}

test('a slot can only be taken once', async () => {
  await signup(A, early, dept1, '2030-01-07', 1, '15:00', '19:00');
  const e = await err(`insert into oc_signups (department_id, block_id, user_id, shift_date, level, block_label, start_at, end_at, hours)
    values ($1, $2, $3, '2030-01-07', 1, 'x', $4, $5, 4)`, [dept1, early, B, at('2030-01-07', '15:00'), at('2030-01-07', '19:00')]);
  assert.equal(e?.code, '23505');
});

test('no one can hold overlapping calls, even in different departments', async () => {
  const e = await err(`insert into oc_signups (department_id, block_id, user_id, shift_date, level, block_label, start_at, end_at, hours)
    values ($1, $2, $3, '2030-01-07', 1, 'x', $4, $5, 6)`, [dept2, other, A, at('2030-01-07', '17:00'), at('2030-01-07', '23:00')]);
  assert.equal(e?.code, '23P01');
  // Back-to-back is fine: 3–7 PM then 7–11 PM.
  await signup(A, late, dept1, '2030-01-07', 1, '19:00', '23:00');
});

test('call levels, days and times are checked', async () => {
  const lvl = await err(`insert into oc_signups (department_id, block_id, user_id, shift_date, level, block_label, start_at, end_at, hours)
    values ($1, $2, $3, '2030-01-08', 4, 'x', now(), now() + interval '1 hour', 1)`, [dept1, early, B]);
  assert.equal(lvl?.code, '23514');
  const days = await err(`insert into oc_blocks (department_id, label, start_time, end_time, days) values ($1, 'x', '07:00', '08:00', '{8}')`, [dept1]);
  assert.equal(days?.code, '23514');
  const noDays = await err(`insert into oc_blocks (department_id, label, start_time, end_time, days) values ($1, 'x', '07:00', '08:00', '{}')`, [dept1]);
  assert.equal(noDays?.code, '23514');
  const lv = await err(`insert into oc_blocks (department_id, label, start_time, end_time, levels) values ($1, 'x', '07:00', '08:00', 4)`, [dept1]);
  assert.equal(lv?.code, '23514');
  const backwards = await err(`insert into oc_signups (department_id, block_id, user_id, shift_date, level, block_label, start_at, end_at, hours)
    values ($1, $2, $3, '2030-01-08', 1, 'x', now(), now() - interval '1 hour', 1)`, [dept1, early, B]);
  assert.equal(backwards?.code, '23514');
});

test('department settings are range-checked', async () => {
  assert.equal((await err(`update oc_departments set period_weeks = 0 where id = $1`, [dept1]))?.code, '23514');
  assert.equal((await err(`update oc_departments set day_reminder_hour = 24 where id = $1`, [dept1]))?.code, '23514');
  assert.equal((await err(`update oc_departments set groups = '{A,B,C,D,E,F,G}' where id = $1`, [dept1]))?.code, '23514');
  assert.equal((await err(`update oc_departments set min_hours = -1 where id = $1`, [dept1]))?.code, '23514');
});

test('staff list: lowercase email, valid phone, unique per department, can be in two departments', async () => {
  assert.equal((await err(`insert into oc_members (department_id, full_name, email) values ($1, 'Up', 'Up@x.com')`, [dept1]))?.code, '23514');
  assert.equal((await err(`insert into oc_members (department_id, full_name, phone) values ($1, 'Ph', '7325551234')`, [dept1]))?.code, '23514');
  await pg.query(`insert into oc_members (department_id, full_name, email) values ($1, 'Jane', 'jane@x.com')`, [dept1]);
  assert.equal((await err(`insert into oc_members (department_id, full_name, email) values ($1, 'Jane 2', 'jane@x.com')`, [dept1]))?.code, '23505');
  await pg.query(`insert into oc_members (department_id, full_name, email) values ($1, 'Jane', 'jane@x.com')`, [dept2]);
});

test('admins must match their level', async () => {
  await pg.query(`insert into oc_admins (scope, full_name, email) values ('system', 'Boss', 'boss@x.com')`);
  assert.equal((await err(`insert into oc_admins (scope, full_name, email) values ('hospital', 'H', 'h@x.com')`))?.code, '23514');
  assert.equal((await err(`insert into oc_admins (scope, full_name) values ('system', 'No contact')`))?.code, '23514');
});

test('periods: one start per department, group order matches open times', async () => {
  const ins = (start, order, opens) => pg.query(
    `insert into oc_periods (department_id, start_date, end_date, signup_start, group_order, opens_at, closes_at)
     values ($1, $2, $2::date + 41, $2::date - 9, $3, $4, now())`, [dept1, start, order, opens]);
  await ins('2030-02-04', ['A', 'B'], [new Date().toISOString(), new Date().toISOString()]);
  assert.equal((await err(`insert into oc_periods (department_id, start_date, end_date, signup_start, opens_at, closes_at) values ($1, '2030-02-04', '2030-03-17', '2030-01-26', '{2030-01-26T13:00:00Z}', now())`, [dept1]))?.code, '23505');
  const mismatch = await err(`insert into oc_periods (department_id, start_date, end_date, signup_start, group_order, opens_at, closes_at)
    values ($1, '2030-04-01', '2030-05-12', '2030-03-23', '{A,B}', '{2030-03-23T13:00:00Z}', now())`, [dept1]);
  assert.equal(mismatch?.code, '23514');
});

async function swap(signupId, from, to, status) {
  return (await one(
    `insert into oc_swaps (department_id, signup_id, from_user, to_user, status, shift_date, block_id, level, block_label, start_at, end_at)
     select department_id, id, $2, $3, $4, shift_date, block_id, level, block_label, start_at, end_at from oc_signups where id = $1 returning id`,
    [signupId, from, to, status],
  )).id;
}
const future = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

test('approval moves the call, resets reminders and stay status', async () => {
  const s = await signup(A, early, dept1, future(10), 2, '15:00', '19:00');
  await pg.query(`update oc_signups set day_reminder_sent_at = now(), stay_status = 'released' where id = $1`, [s]);
  const sw = await swap(s, A, B, 'pending_manager');
  const r = await one(`select * from oc_approve_swap($1, $2, null, null)`, [sw, M]);
  assert.equal(r.status, 'approved');
  assert.equal(r.manager_id, M);
  const row = await one(`select user_id, day_reminder_sent_at, stay_status from oc_signups where id = $1`, [s]);
  assert.deepEqual(row, { user_id: B, day_reminder_sent_at: null, stay_status: null });
  assert.match((await err(`select oc_approve_swap($1, $2, null, null)`, [sw, M]))?.message || '', /SWAP_NOT_PENDING/);
});

test('without manager approval, the colleague\'s acceptance completes the switch', async () => {
  const s = await signup(A, early, dept1, future(11), 1, '15:00', '19:00');
  const sw = await swap(s, A, C, 'pending_colleague');
  assert.match((await err(`select oc_approve_swap($1, $2, null, null)`, [sw, M]))?.message || '', /SWAP_NOT_PENDING/);
  const r = await one(`select * from oc_approve_swap($1, null, null, null)`, [sw]);
  assert.equal(r.status, 'approved');
  assert.equal(r.manager_id, null);
  assert.equal((await one(`select user_id from oc_signups where id = $1`, [s])).user_id, C);
});

test('approval fails, and nothing changes, if the colleague has an overlapping call', async () => {
  const day = future(12);
  const s = await signup(A, early, dept1, day, 1, '15:00', '19:00');
  await signup(B, other, dept2, day, 1, '17:00', '23:00');
  const sw = await swap(s, A, B, 'pending_manager');
  assert.equal((await err(`select oc_approve_swap($1, $2, null, null)`, [sw, M]))?.code, '23P01');
  assert.equal((await one(`select user_id from oc_signups where id = $1`, [s])).user_id, A);
  assert.equal((await one(`select status from oc_swaps where id = $1`, [sw])).status, 'pending_manager');
});

test('only one open switch per call', async () => {
  const s = await signup(A, late, dept1, future(13), 1, '19:00', '23:00');
  await swap(s, A, B, 'pending_colleague');
  const e = await err(`insert into oc_swaps (department_id, signup_id, from_user, to_user, shift_date, block_id, level, block_label, start_at, end_at)
    select department_id, id, $2, $3, shift_date, block_id, level, block_label, start_at, end_at from oc_signups where id = $1`, [s, A, C]);
  assert.equal(e?.code, '23505');
});

test('a call time with sign-ups cannot be deleted (history is kept)', async () => {
  assert.equal((await err(`delete from oc_blocks where id = $1`, [early]))?.code, '23001'); // restrict_violation
});

test('browser roles cannot run the approval function; row-level security is on everywhere', async () => {
  const fn = 'public.oc_approve_swap(uuid,uuid,timestamptz,timestamptz)';
  const r = await one(`select has_function_privilege('anon', '${fn}', 'execute') a, has_function_privilege('authenticated', '${fn}', 'execute') b, has_function_privilege('service_role', '${fn}', 'execute') c`);
  assert.deepEqual(r, { a: false, b: false, c: true });
  const t = await pg.query(`select relname, relrowsecurity from pg_class where relname like 'oc\\_%' and relkind = 'r' order by relname`);
  assert.equal(t.rows.length, 12);
  assert.ok(t.rows.every((x) => x.relrowsecurity), JSON.stringify(t.rows));
});
