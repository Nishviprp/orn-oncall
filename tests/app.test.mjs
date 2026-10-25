// End-to-end: the real Worker and API code against an in-memory PostgreSQL with the real schema.
// Walks through what admins, managers and nurses do, and checks the emails that go out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import worker from '../src/worker.mjs';
import { setDbForTests, todayInTz, addDays, isoDay } from '../src/lib.mjs';
import { runReminders } from '../src/reminders.mjs';
import { fakeSupabase, SUPABASE_LIKE_PARSERS } from './helpers/fake-supabase.mjs';

const ENV = {
  SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc',
  RESEND_API_KEY: 're_test', EMAIL_FROM: 'ON CALL <oncall@ornglobal.com>', SITE_URL: 'https://oncall.example.com', REDIRECT_HOME: 'true',
  ASSETS: { fetch: async () => new Response('asset') },
};
const id = (n) => `00000000-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
const PEOPLE = {
  boss: { id: id(1), email: 'boss@x.com' },
  mgr: { id: id(2), email: 'mgr@x.com' },
  a: { id: id(3), email: 'a@x.com' },
  b: { id: id(4), email: 'b@x.com' },
  c: { id: id(5), email: 'c@x.com', phone: '17325550000' },
  west: { id: id(6), email: 'west@x.com' },
};
const sent = [];
let realFetch;

async function call(who, method, path, body) {
  const res = await worker.fetch(new Request('https://oncall.example.com/api/oncall/' + path, {
    method,
    headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json', origin: 'https://oncall.example.com' },
    body: body ? JSON.stringify(body) : undefined,
  }), ENV);
  const json = await res.json();
  return { ...json, http: res.status };
}
const ok = async (...args) => {
  const r = await call(...args);
  assert.equal(r.http, 200, `${args[1]} ${args[2]} → ${r.http} ${r.error || ''}`);
  return r;
};
const mailsTo = (email) => sent.filter((m) => m.to.includes(email));
const lastMail = (email) => mailsTo(email).at(-1);

let org, hosp, dept, early, late, shiftDay, shiftMid, westDept;
const TZ = 'America/New_York';
const today = () => todayInTz(new Date(), TZ);
// Next Mon–Sat day at least `n` days ahead.
const weekdayAhead = (n) => {
  let d = addDays(today(), n);
  while (isoDay(d) === 7) d = addDays(d, 1);
  return d;
};

before(async () => {
  const pg = new PGlite({ extensions: { btree_gist }, parsers: SUPABASE_LIKE_PARSERS });
  await pg.exec(`create schema auth; create table auth.users (id uuid primary key); create role anon; create role authenticated; create role service_role;`);
  await pg.exec((await readFile(new URL('../supabase/schema.sql', import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', ''));
  for (const p of Object.values(PEOPLE)) await pg.query('insert into auth.users (id) values ($1)', [p.id]);
  await pg.query(`insert into oc_admins (scope, full_name, email) values ('system', 'Boss', 'boss@x.com')`);
  setDbForTests(fakeSupabase(pg, new Map(Object.entries(PEOPLE).map(([k, v]) => [k, v]))));
  realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      const b = JSON.parse(init.body);
      sent.push({ to: b.to, subject: b.subject, text: b.text });
      return new Response('{}', { status: 200 });
    }
    throw new Error('Unexpected network call ' + url);
  };
});
after(() => {
  globalThis.fetch = realFetch;
  setDbForTests(null);
});

test('system admin sets up an organization, a hospital and a department from a template', async () => {
  org = (await ok('boss', 'POST', 'admin/orgs', { name: 'Garden Health' })).id;
  hosp = (await ok('boss', 'POST', 'admin/hospitals', { orgId: org, name: 'Morris Cancer Center', state: 'NJ', city: 'Edison' })).id;
  dept = (await ok('boss', 'POST', 'admin/departments', {
    hospitalId: hosp, name: 'OR', template: 'or_call_sheet', managerName: 'Pat Manager', managerEmail: 'MGR@x.com',
  })).id;
  const tree = await ok('boss', 'GET', 'admin/tree');
  const h = tree.orgs[0].hospitals[0];
  assert.equal(h.timezone, 'America/New_York'); // from the state
  assert.deepEqual(h.departments.map((d) => [d.name, d.managers]), [['OR', 1]]);
  assert.ok(tree.templates.some((t) => t.id === 'weekend_24h'));
});

test('a nurse cannot use admin or manager screens', async () => {
  assert.equal((await call('a', 'GET', 'admin/tree')).http, 403);
  assert.equal((await call('a', 'GET', `manage/settings?d=${dept}`)).http, 403);
  assert.equal((await call('mgr', 'POST', 'admin/orgs', { name: 'Nope Org' })).http, 403);
});

test('the manager sees the template settings and changes a call time from the screen', async () => {
  const me = await ok('mgr', 'GET', 'me');
  assert.deepEqual(me.departments.map((d) => [d.name, d.canManage]), [['OR', true]]);
  const s = await ok('mgr', 'GET', `manage/settings?d=${dept}`);
  early = s.blocks.find((b) => b.label === '3–7 PM');
  late = s.blocks.find((b) => b.label === '7–11 PM');
  shiftDay = s.shifts.find((x) => x.name === '7a–3p').id;
  shiftMid = s.shifts.find((x) => x.name === '11a–7p').id;
  assert.equal(early.levels, 2);
  assert.equal(late.levels, 1);
  assert.equal(s.rules[late.id][shiftDay], 'after_close');

  // Move the afternoon call to 3:30–7:30 PM.
  const r = await ok('mgr', 'POST', `manage/blocks?d=${dept}`, { ...early, startTime: '15:30', endTime: '19:30' });
  assert.equal(r.hours, 4);
  const again = await ok('mgr', 'GET', `manage/settings?d=${dept}`);
  assert.equal(again.blocks.find((b) => b.id === early.id).timeLabel, '3:30 PM – 7:30 PM');

  // Change general settings.
  const g = await ok('mgr', 'POST', `manage/settings?d=${dept}`, { ...again, minHours: 20, cancelCutoffHours: 48 });
  assert.equal(g.saved, true);
  assert.equal((await ok('mgr', 'GET', `manage/settings?d=${dept}`)).minHours, 20);

  // Bad values are refused with a clear message.
  const bad = await call('mgr', 'POST', `manage/settings?d=${dept}`, { ...again, periodWeeks: 0 });
  assert.equal(bad.http, 400);
  assert.match(bad.error, /Period length/);
  const noDays = await call('mgr', 'POST', `manage/blocks?d=${dept}`, { label: 'X', startTime: '07:00', endTime: '08:00', days: [], levels: 1 });
  assert.match(noDays.error, /at least one day/);
});

test('the manager adds staff by pasting a list', async () => {
  const r = await ok('mgr', 'POST', `manage/staff/import?d=${dept}`, {
    text: 'Nurse A, a@x.com, A, 7a–3p\nNurse B, b@x.com, Group B, 11a–7p\nNurse C, (732) 555-0000, B, 7a–3p, c@x.com\nNo Contact, A\nNurse A again, a@x.com',
  });
  assert.equal(r.added, 3);
  assert.equal(r.problems.length, 2);
  for (const who of ['a', 'b', 'c', 'mgr']) await ok(who, 'POST', 'me', { full_name: `Nurse ${who.toUpperCase()}` });
  const staff = await ok('mgr', 'GET', `manage/staff?d=${dept}`);
  assert.equal(staff.staff.find((x) => x.email === 'b@x.com').shiftName, '11a–7p');
});

test('the manager opens a 6-week period; sign-up rules follow the settings', async () => {
  const t = today();
  const p = await ok('mgr', 'POST', `manage/periods?d=${dept}`, { startDate: t, signupStart: addDays(t, -2), groupOrder: ['A', 'B'] });
  assert.equal(p.period.phase, 'vacancy'); // sign-up window already over → vacancies phase
  const bad = await call('mgr', 'POST', `manage/periods?d=${dept}`, { startDate: addDays(t, 7), signupStart: t, groupOrder: ['A', 'B'] });
  assert.match(bad.error, /overlaps/);
});

let day1, day2, signupA;

test('nurses sign up; slots fill once; shift rules apply; overlapping calls are refused', async () => {
  day1 = weekdayAhead(3);
  day2 = weekdayAhead(5);
  const board = await ok('a', 'GET', `slots?d=${dept}&week=${day1}`);
  const slot = board.days.find((d) => d.date === day1).blocks.find((b) => b.blockId === early.id);
  assert.equal(slot.timeLabel, '3:30 PM – 7:30 PM');
  assert.equal(slot.roles[0].status, 'open');

  const booked = await ok('a', 'POST', 'book', { blockId: early.id, date: day1, level: 1 });
  signupA = booked.call.id;
  assert.equal(booked.minHours, 20);
  assert.equal(booked.hours, 4);
  assert.match(lastMail('a@x.com').subject, /On call confirmed: First call/);
  assert.match(lastMail('a@x.com').text, /4 of 20 required call hours/);

  assert.equal((await call('c', 'POST', 'book', { blockId: early.id, date: day1, level: 1 })).http, 409);
  const wrongShift = await call('b', 'POST', 'book', { blockId: early.id, date: day1, level: 1 });
  assert.equal(wrongShift.http, 403);
  assert.match(wrongShift.error, /3–7 PM is for 7a–3p staff/);
  assert.equal((await call('b', 'POST', 'book', { blockId: late.id, date: day1, level: 2 })).http, 403); // evening has no second call

  // After sign-up closes, 7a–3p staff can fill the evening.
  await ok('c', 'POST', 'book', { blockId: late.id, date: day1, level: 1 });

  // 3:30–7:30 PM and 7–11 PM now overlap by 30 minutes.
  await ok('a', 'POST', 'book', { blockId: early.id, date: day2, level: 2 });
  const overlap = await call('a', 'POST', 'book', { blockId: late.id, date: day2, level: 1 });
  assert.equal(overlap.http, 409);
  assert.match(overlap.error, /overlaps/);

  const mine = await ok('a', 'GET', 'my-calls');
  assert.equal(mine.calls.length, 2);
  assert.equal(mine.progress[0].hours, 8);
  assert.equal(mine.progress[0].minHours, 20);
});

test('switch: colleague accepts, manager approves, both told "Your switch has been approved"', async () => {
  const cant = await call('a', 'POST', 'switches/request', { signupId: signupA, toUserId: PEOPLE.b.id });
  assert.equal(cant.http, 400); // 11a–7p can't take 3–7 PM
  const colleagues = await ok('a', 'GET', `colleagues?signupId=${signupA}`);
  assert.deepEqual(colleagues.colleagues.map((x) => x.name), ['Nurse C']);

  // C already has the evening that day, which doesn't overlap 3:30–7:30? It does (7–7:30), so pick day2's call instead.
  const day2Call = (await ok('a', 'GET', 'my-calls')).calls.find((x) => x.date === day2);
  const req = await ok('a', 'POST', 'switches/request', { signupId: day2Call.id, toUserId: PEOPLE.c.id, note: 'Family event' });
  assert.match(lastMail('c@x.com').subject, /Nurse A wants to give you a call/);
  const incoming = await ok('c', 'GET', 'switches');
  assert.equal(incoming.incoming.length, 1);
  await ok('c', 'POST', 'switches/respond', { swapId: req.swapId, accept: true });
  assert.match(lastMail('mgr@x.com').subject, /Switch needs your approval/);

  const queue = await ok('mgr', 'GET', 'switches');
  assert.equal(queue.approvals.length, 1);
  await ok('mgr', 'POST', 'switches/decide', { swapId: req.swapId, approve: true });
  assert.equal(lastMail('a@x.com').subject, 'Your switch has been approved');
  assert.equal(lastMail('c@x.com').subject, 'Your switch has been approved');
  assert.ok((await ok('c', 'GET', 'my-calls')).calls.some((x) => x.date === day2 && x.blockLabel === '3–7 PM'));
});

test('with approval turned off in Settings, acceptance completes the switch', async () => {
  const s = await ok('mgr', 'GET', `manage/settings?d=${dept}`);
  await ok('mgr', 'POST', `manage/settings?d=${dept}`, { ...s, switchNeedsApproval: false });
  const day3 = weekdayAhead(8);
  const c = await ok('c', 'POST', 'book', { blockId: late.id, date: day3, level: 1 });
  const req = await ok('c', 'POST', 'switches/request', { signupId: c.call.id, toUserId: PEOPLE.b.id });
  const r = await ok('b', 'POST', 'switches/respond', { swapId: req.swapId, accept: true });
  assert.equal(r.status, 'approved');
  assert.equal(lastMail('b@x.com').subject, 'Your switch is confirmed');
});

test('manager tells a nurse they are released; hours report adds up', async () => {
  const t = await ok('mgr', 'GET', `manage/today?d=${dept}&date=${day1}`);
  assert.equal(t.calls.length, 2);
  const callA = t.calls.find((x) => x.name === 'Nurse A');
  await ok('mgr', 'POST', 'manage/stay', { signupId: callA.id, status: 'released', note: 'Slow day' });
  assert.match(lastMail('a@x.com').subject, /released from call/);
  const h = await ok('mgr', 'GET', `manage/hours?d=${dept}`);
  const byName = Object.fromEntries(h.staff.map((x) => [x.name, x.hours]));
  assert.deepEqual(byName, { 'Nurse A': 4, 'Nurse B': 4, 'Nurse C': 8 });
  assert.equal(h.minHours, 20);
});

test('reminders go out at the right time and only once', async () => {
  const before = sent.length;
  const call1 = (await ok('c', 'GET', 'my-calls')).calls.find((x) => x.date === day1);
  const at = new Date(Date.parse(call1.startAt) - 30 * 60000);
  const r1 = await runReminders(at);
  assert.ok(r1.hour >= 1);
  assert.ok(sent.slice(before).some((m) => m.to.includes('c@x.com') && /starts soon/.test(m.subject)));
  const r2 = await runReminders(at);
  assert.equal(r2.hour, 0);
});

test('a second hospital in another state and time zone, with a nurse in both', async () => {
  const west = (await ok('boss', 'POST', 'admin/hospitals', { orgId: org, name: 'Bay Medical', state: 'CA' })).id;
  westDept = (await ok('boss', 'POST', 'admin/departments', { hospitalId: west, name: 'Cath Lab', template: 'weekend_24h', managerName: 'West Mgr', managerEmail: 'west@x.com' })).id;
  // Hospital admin for Bay Medical can manage Cath Lab but not the NJ OR.
  await ok('boss', 'POST', 'admin/admins', { scope: 'hospital', hospitalId: west, fullName: 'West Mgr', email: 'west@x.com' });
  assert.equal((await call('west', 'GET', `manage/settings?d=${dept}`)).http, 403);
  const ws = await ok('west', 'GET', `manage/settings?d=${westDept}`);
  assert.equal(ws.hospital.timezone, 'America/Los_Angeles');
  assert.equal(ws.blocks[0].timeLabel, '7:00 AM – 7:00 AM (next day)');

  await ok('west', 'POST', `manage/staff?d=${westDept}`, { fullName: 'Nurse A', email: 'a@x.com' });
  const me = await ok('a', 'GET', 'me');
  assert.deepEqual(me.departments.map((d) => d.name).sort(), ['Cath Lab', 'OR']);
  const board = await ok('a', 'GET', `slots?d=${westDept}`);
  assert.equal(board.department.timezone, 'America/Los_Angeles');
  assert.ok(board.days.every((d) => [6, 7].includes(isoDay(d.date))));
});

test('removing call levels with upcoming sign-ups is refused; call times with history are turned off, not deleted', async () => {
  const r = await call('mgr', 'POST', `manage/blocks?d=${dept}`, { ...early, startTime: '15:30', endTime: '19:30', levels: 1 });
  assert.equal(r.http, 409);
  const del = await call('mgr', 'POST', `manage/blocks/delete?d=${dept}`, { id: early.id });
  assert.equal(del.http, 409);
  assert.match(del.error, /upcoming sign-up/);
});
