// The rules engine, driven by department settings (no database needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setEnv, zonedToUtc, todayInTz, mondayOf, addDays, isoDay, formatShortWhen, timeRangeLabel, normPhone, normEmail, matchesContact } from '../src/lib.mjs';
import {
  makeConfig, blockTimes, nominalHours, daysLabel, buildPeriod, phaseOf, openedGroups, memberOpensAt, canTake, canReceive,
  validateNewPeriod, suggestNext, rotate, openSlotsAfterClose, slotCount, describePeriod, describeCall, reminderFlags,
} from '../src/dept.mjs';
import { mergeMembers, buildAccess, canManage } from '../src/access.mjs';
import { buildMessage, buildNotice } from '../src/messages.mjs';
import { reminderDue } from '../src/reminders.mjs';

setEnv({});

const DEPT_DEFAULTS = {
  use_periods: true, period_weeks: 6, min_hours: 24, groups: ['A', 'B'], group_gap_days: 1, signup_open_time: '08:00:00',
  signup_close_days: 0, book_weeks_ahead: 8, vacancy_open_days: 7, cancel_cutoff_hours: 24, day_reminder_hour: 8,
  hour_reminder_minutes: 60, switch_needs_approval: true, active: true,
};
const hospital = (tz = 'America/New_York') => ({ id: 'h1', name: 'Morris', state: 'NJ', timezone: tz, org_id: 'o1', org: { id: 'o1', name: 'Health System' } });

// The Call Information Sheet department.
const OR = makeConfig(
  { id: 'd1', name: 'OR', ...DEPT_DEFAULTS, hospital: hospital() },
  [
    { id: 'b-early', label: '3–7 PM', start_time: '15:00:00', end_time: '19:00:00', days: [1, 2, 3, 4, 5, 6], levels: 2, active: true, sort: 1 },
    { id: 'b-late', label: '7–11 PM', start_time: '19:00:00', end_time: '23:00:00', days: [1, 2, 3, 4, 5, 6], levels: 1, active: true, sort: 2 },
  ],
  [{ id: 's-day', name: '7a–3p', active: true }, { id: 's-mid', name: '11a–7p', active: true }],
  [
    { block_id: 'b-early', shift_id: 's-day', access: 'signup' },
    { block_id: 'b-late', shift_id: 's-mid', access: 'signup' },
    { block_id: 'b-late', shift_id: 's-day', access: 'after_close' },
  ],
);

const P = { id: 'p1', ...buildPeriod(OR, { startDate: '2026-11-02', signupStart: '2026-10-31', groupOrder: ['A', 'B'] }) };
const BEFORE = new Date('2026-10-30T16:00:00Z');
const SAT = new Date('2026-10-31T14:00:00Z'); // Sat 10 AM EDT
const SUN = new Date('2026-11-01T15:00:00Z'); // Sun 10 AM EST
const MON = new Date('2026-11-02T13:00:00Z'); // after close

const dayA = { group_name: 'A', shift_id: 's-day' };
const dayB = { group_name: 'B', shift_id: 's-day' };
const midA = { group_name: 'A', shift_id: 's-mid' };
const midB = { group_name: 'B', shift_id: 's-mid' };
const block = (id) => OR.blocks.find((b) => b.id === id);
const take = (now, member, blockId, level = 1, date = '2026-11-03') => canTake({ cfg: OR, period: P, now, member, block: block(blockId), level, date });

test('time zone helpers', () => {
  assert.equal(zonedToUtc('2027-01-12', '15:00', 'America/New_York').toISOString(), '2027-01-12T20:00:00.000Z');
  assert.equal(zonedToUtc('2027-01-12', '15:00', 'America/Los_Angeles').toISOString(), '2027-01-12T23:00:00.000Z');
  assert.equal(zonedToUtc('2027-07-13', '15:00', 'America/Phoenix').toISOString(), '2027-07-13T22:00:00.000Z');
  assert.equal(todayInTz(new Date('2026-10-23T02:30:00Z'), 'America/New_York'), '2026-10-22');
  assert.equal(todayInTz(new Date('2026-10-23T02:30:00Z'), 'Pacific/Honolulu'), '2026-10-22');
  assert.equal(mondayOf('2026-10-25'), '2026-10-19'); // Sunday belongs to the week that started Monday
  assert.equal(isoDay('2026-10-25'), 7);
  assert.equal(formatShortWhen('2026-10-31T12:00:00Z', 'America/New_York'), 'Sat 8 AM');
  assert.equal(timeRangeLabel('19:00', '07:00'), '7:00 PM – 7:00 AM (next day)');
});

test('call times: same day, overnight, 24 hours, across a clock change', () => {
  const evening = blockTimes(block('b-late'), '2026-11-03', OR.tz);
  assert.equal(evening.startAt.toISOString(), '2026-11-04T00:00:00.000Z');
  assert.equal(evening.hours, 4);
  const night = { start_time: '19:00', end_time: '07:00', days: [1] };
  assert.equal(nominalHours(night), 12);
  assert.equal(blockTimes(night, '2026-10-31', OR.tz).hours, 13); // clocks go back overnight (Nov 1, 2026)
  const full = { start_time: '07:00', end_time: '07:00', days: [6] };
  assert.equal(nominalHours(full), 24);
  assert.equal(blockTimes(full, '2027-03-13', OR.tz).hours, 23); // clocks go forward
  assert.equal(daysLabel([1, 2, 3, 4, 5, 6]), 'Mon–Sat');
  assert.equal(daysLabel([6, 7]), 'Sat–Sun');
  assert.equal(daysLabel([1, 3, 5]), 'Mon, Wed, Fri');
});

test('period built from department settings', () => {
  assert.equal(P.end_date, '2026-12-13');
  assert.deepEqual(P.opens_at, ['2026-10-31T12:00:00.000Z', '2026-11-01T13:00:00.000Z']);
  assert.equal(P.closes_at, '2026-11-02T05:00:00.000Z');
  assert.equal(phaseOf(P, BEFORE), 'before');
  assert.equal(phaseOf(P, SAT), 'open');
  assert.deepEqual(openedGroups(P, SAT), ['A']);
  assert.deepEqual(openedGroups(P, SUN), ['A', 'B']);
  assert.equal(phaseOf(P, MON), 'vacancy');
  assert.equal(memberOpensAt(P, { group_name: 'Z' }), P.opens_at[1]);
  const d = describePeriod(P, OR, SAT);
  assert.equal(d.phaseLabel, 'Open for Group A');
  assert.equal(d.closesLabel, 'Sun, Nov 1, 11:59 PM');
  assert.equal(describePeriod(P, OR, SUN).phaseLabel, 'Open for all groups');
});

test('call sheet rules: groups, shifts and vacancies', () => {
  assert.match(take(BEFORE, dayA, 'b-early').reason, /Sign-up opens Sat, Oct 31, 8:00 AM/);
  assert.equal(take(SAT, dayA, 'b-early').ok, true);
  assert.equal(take(SAT, dayA, 'b-early', 2).ok, true);
  assert.match(take(SAT, dayB, 'b-early').reason, /Group A signs up first/);
  assert.equal(take(SAT, dayB, 'b-early').short, 'Opens Sun 8 AM');
  assert.equal(take(SUN, dayB, 'b-early').ok, true);
  assert.equal(take(SUN, midB, 'b-late').ok, true);
  assert.match(take(SUN, midB, 'b-early').reason, /3–7 PM is for 7a–3p staff/);
  assert.equal(take(SUN, dayA, 'b-late').short, 'After sign-up closes');
  assert.equal(take(MON, dayA, 'b-late').ok, true);
  assert.equal(take(MON, midA, 'b-early').ok, false);
  assert.equal(take(SUN, midA, 'b-late', 2).ok, false); // evening has first call only
  assert.equal(take(SUN, midA, 'b-late', 1, '2026-11-08').ok, false); // no Sunday call
  assert.match(take(SUN, { group_name: 'A', shift_id: null }, 'b-early').reason, /set your shift/);
  assert.match(canTake({ cfg: OR, period: null, now: SUN, member: dayA, block: block('b-early'), level: 1, date: '2026-11-03' }).reason, /not been opened/);
});

test('who can receive a switched call', () => {
  assert.equal(canReceive(OR, dayB, block('b-early')), true);
  assert.equal(canReceive(OR, midB, block('b-early')), false);
  assert.equal(canReceive(OR, dayB, block('b-late')), true);
  assert.equal(canReceive(OR, { shift_id: null }, block('b-late')), false);
});

test('a very different department: weekend 24 h call, no groups, no shifts, Pacific time', () => {
  const W = makeConfig(
    { id: 'd2', name: 'Cath Lab', ...DEPT_DEFAULTS, period_weeks: 4, groups: [], signup_close_days: 2, hospital: hospital('America/Los_Angeles') },
    [{ id: 'w', label: 'Weekend 24 h', start_time: '07:00', end_time: '07:00', days: [6, 7], levels: 2, active: true }],
    [], [],
  );
  const p = buildPeriod(W, { startDate: '2026-11-02', signupStart: '2026-10-29', groupOrder: [] });
  assert.equal(p.end_date, '2026-11-29');
  assert.deepEqual(p.opens_at, ['2026-10-29T15:00:00.000Z']); // 8 AM PDT
  assert.equal(p.closes_at, '2026-11-01T07:00:00.000Z'); // end of Oct 31 PDT
  const now = new Date('2026-10-30T18:00:00Z');
  const anyone = { group_name: null, shift_id: null };
  const b = W.blocks[0];
  assert.equal(canTake({ cfg: W, period: p, now, member: anyone, block: b, level: 2, date: '2026-11-07' }).ok, true);
  assert.equal(canTake({ cfg: W, period: p, now, member: anyone, block: b, level: 1, date: '2026-11-06' }).ok, false); // Friday
  assert.equal(canReceive(W, anyone, b), true);
  assert.equal(slotCount(W, p.start_date, p.end_date), 16); // 8 weekend days × 2 calls
});

test('a department without periods: book ahead and vacancy window', () => {
  const S = makeConfig(
    { id: 'd3', name: 'Endo', ...DEPT_DEFAULTS, use_periods: false, groups: [], book_weeks_ahead: 2, vacancy_open_days: 3, hospital: hospital('America/Chicago') },
    [{ id: 'e', label: 'Evening', start_time: '17:00', end_time: '23:00', days: [1, 2, 3, 4, 5], levels: 1, active: true }],
    [{ id: 'rn', name: 'RN', active: true }, { id: 'tech', name: 'Tech', active: true }],
    [{ block_id: 'e', shift_id: 'rn', access: 'signup' }, { block_id: 'e', shift_id: 'tech', access: 'after_close' }],
  );
  const now = new Date('2026-10-26T15:00:00Z'); // Mon
  const b = S.blocks[0];
  assert.equal(canTake({ cfg: S, now, member: { shift_id: 'rn' }, block: b, level: 1, date: '2026-11-06' }).ok, true);
  assert.match(canTake({ cfg: S, now, member: { shift_id: 'rn' }, block: b, level: 1, date: '2026-11-10' }).reason, /2 weeks ahead/);
  assert.match(canTake({ cfg: S, now, member: { shift_id: 'tech' }, block: b, level: 1, date: '2026-11-06' }).reason, /3 days before the call/);
  assert.equal(canTake({ cfg: S, now, member: { shift_id: 'tech' }, block: b, level: 1, date: '2026-10-28' }).ok, true);
});

test('three groups rotate; new period validation', () => {
  const G = makeConfig({ id: 'd4', name: 'ICU', ...DEPT_DEFAULTS, groups: ['A', 'B', 'C'], group_gap_days: 2, hospital: hospital() }, [], [], []);
  assert.deepEqual(rotate(['A', 'B', 'C']), ['B', 'C', 'A']);
  const p = buildPeriod(G, { startDate: '2026-12-07', signupStart: '2026-11-21', groupOrder: ['C', 'A', 'B'] });
  assert.equal(p.opens_at.length, 3);
  assert.equal(p.opens_at[2], '2026-11-25T13:00:00.000Z'); // 4 days later, 8 AM EST
  const s = suggestNext(G, [p], '2026-11-01');
  assert.deepEqual(s.groupOrder, ['A', 'B', 'C']);
  assert.equal(s.startDate, '2027-01-18');
  const ok = { startDate: '2027-01-18', signupStart: '2027-01-02', groupOrder: ['A', 'B', 'C'] };
  assert.deepEqual(validateNewPeriod(G, ok, [p], '2026-11-01'), []);
  assert.match(validateNewPeriod(G, { ...ok, groupOrder: ['A', 'B'] }, [p], '2026-11-01').join(' '), /every group/);
  assert.match(validateNewPeriod(G, { ...ok, signupStart: '2027-01-15' }, [p], '2026-11-01').join(' '), /finish before the period starts/);
  assert.match(validateNewPeriod(G, { ...ok, startDate: '2026-12-14' }, [p], '2026-11-01').join(' '), /overlaps/);
  assert.match(validateNewPeriod(G, { ...ok, startDate: '2026-10-01' }, [], '2026-11-01').join(' '), /past/);
});

test('first suggestion for the call sheet department', () => {
  assert.deepEqual(suggestNext(OR, [P], '2026-10-24'), { startDate: '2026-12-14', signupStart: '2026-12-05', groupOrder: ['B', 'A'] });
});

test('open slots after close are counted per shift', () => {
  const taken = [{ block_id: 'b-late', shift_date: '2026-11-02', level: 1 }, { block_id: 'b-late', shift_date: '2026-11-03', level: 1 }];
  const r = openSlotsAfterClose(OR, P, taken, MON);
  assert.equal(r.total, 34); // 36 Mon–Sat evenings − 2 taken (Nov 2 not started yet at 8 AM)
  assert.equal(r.byShift['s-day'], 34);
  assert.equal(r.byShift['s-mid'], undefined);
});

test('reminders follow each department\'s settings and time zone', () => {
  const row = { start_at: '2026-11-03T20:00:00.000Z', shift_date: '2026-11-03', day_reminder_sent_at: null, hour_reminder_sent_at: null };
  assert.equal(reminderDue('day', row, OR, new Date('2026-11-03T12:30:00Z')), false); // 7:30 AM
  assert.equal(reminderDue('day', row, OR, new Date('2026-11-03T13:05:00Z')), true); // 8:05 AM
  assert.equal(reminderDue('hour', row, OR, new Date('2026-11-03T18:30:00Z')), false);
  assert.equal(reminderDue('hour', row, OR, new Date('2026-11-03T19:05:00Z')), true);
  const f = reminderFlags(OR, '2026-11-03', '2026-11-03T20:00:00Z', new Date('2026-11-03T19:30:00Z'));
  assert.ok(f.day_reminder_sent_at && f.hour_reminder_sent_at);
});

test('people: merge rows, managers and admins', () => {
  const merged = mergeMembers([
    { id: 'm1', department_id: 'd1', is_manager: false, group_name: 'B', shift_id: null, full_name: 'X' },
    { id: 'm2', department_id: 'd1', is_manager: true, group_name: null, shift_id: 's-day', full_name: 'X' },
  ]);
  assert.deepEqual(merged.d1, { department_id: 'd1', ids: ['m1', 'm2'], is_manager: true, group_name: 'B', shift_id: 's-day', full_name: 'X' });
  const contact = { email: 'me@x.com', phone: null };
  assert.ok(matchesContact({ email: 'me@x.com' }, contact));
  const staff = buildAccess({ id: 'u' }, contact, [{ id: 'm', department_id: 'd1', email: 'me@x.com', is_manager: false }], []);
  assert.equal(canManage(staff, OR), false);
  const hospAdmin = buildAccess({ id: 'u' }, contact, [], [{ id: 'a', scope: 'hospital', hospital_id: 'h1', email: 'me@x.com' }]);
  assert.equal(canManage(hospAdmin, OR), true);
  const otherHosp = buildAccess({ id: 'u' }, contact, [], [{ id: 'a', scope: 'hospital', hospital_id: 'h9', email: 'me@x.com' }]);
  assert.equal(canManage(otherHosp, OR), false);
  const orgAdmin = buildAccess({ id: 'u' }, contact, [], [{ id: 'a', scope: 'org', org_id: 'o1', email: 'me@x.com' }]);
  assert.equal(canManage(orgAdmin, OR), true);
  const notMine = buildAccess({ id: 'u' }, contact, [], [{ id: 'a', scope: 'system', email: 'other@x.com' }]);
  assert.equal(notMine.system, false);
});

test('contact clean-up', () => {
  assert.equal(normPhone('(732) 555-1234'), '+17325551234');
  assert.equal(normPhone('+44 20 7946 0958'), '+442079460958');
  assert.throws(() => normPhone('12345'));
  assert.equal(normEmail(' Me@X.com '), 'me@x.com');
  assert.throws(() => normEmail('nope'));
});

test('messages carry the department and call time name', () => {
  const call = describeCall({ id: 'x', shift_date: '2026-11-03', block_id: 'b-late', block_label: '7–11 PM', level: 1, start_at: '2026-11-04T00:00:00Z', end_at: '2026-11-04T04:00:00Z', hours: 4 }, OR);
  assert.equal(call.timeLabel, '7:00 PM – 11:00 PM');
  assert.equal(call.departmentName, 'OR · Morris');
  const m = buildMessage('confirm', 'Jane Doe', call, { hours: 8, minHours: 24, periodLabel: 'Nov 2 – Dec 13' });
  assert.equal(m.dept, 'OR · Morris');
  assert.match(m.lines[1], /First call \(7–11 PM\) on Tuesday, November 3, 2026, 7:00 PM – 11:00 PM/);
  assert.match(m.lines.join(' '), /\?d=d1/);
  for (const k of ['swap_approved_from', 'swap_approved_to']) {
    const x = buildMessage(k, 'A', call, { from: 'Jane', to: 'Alex' });
    assert.equal(x.subject, 'Your switch has been approved');
    assert.ok(x.lines.includes('Your switch has been approved.'));
  }
  assert.match(buildMessage('swap_confirmed_to', 'A', call, { from: 'Jane' }).subject, /confirmed/);
  assert.match(buildMessage('stay', 'A', call, { isToday: true }).sms, /STAY .* today/);
  const n = buildNotice('signup_open', 'Jane', { dept: 'OR · Morris', deptId: 'd1', group: 'A', periodLabel: 'Nov 2 – Dec 13', closesLabel: 'Sun', minHours: 24 });
  assert.match(n.subject, /open for Group A/);
  assert.match(buildNotice('vacancies', 'Jane', { dept: 'OR', deptId: 'd1', count: 3, periodLabel: 'x' }).subject, /3 open call slots/);
});
