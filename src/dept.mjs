// Department configuration and the call rules built on it.
// Nothing here is hard-coded to one department: call times, number of calls, shifts, who can take
// which call, groups and sign-up windows all come from the department's settings.
import {
  db, must, HttpError, LEVELS, DAY_NAMES, TIME_ZONES, addDays, isoDay, mondayOf, zonedToUtc, todayInTz, formatDateShort, formatDateLong,
  formatWhen, formatShortWhen, hhmm, timeRangeLabel, rangeFromInstants,
} from './lib.mjs';

// ---------- loading ----------

const DEPT_SELECT = '*, hospital:oc_hospitals(id, name, state, city, timezone, org_id, org:oc_orgs(id, name))';

export async function loadDept(deptId) {
  const dept = must(await db().from('oc_departments').select(DEPT_SELECT).eq('id', deptId).maybeSingle());
  if (!dept) throw new HttpError(404, 'Department not found.');
  const [blocks, shifts] = await Promise.all([
    db().from('oc_blocks').select('*').eq('department_id', deptId).order('sort').order('start_time'),
    db().from('oc_shifts').select('*').eq('department_id', deptId).order('sort').order('name'),
  ]);
  const blockRows = must(blocks);
  const ruleRows = blockRows.length ? must(await db().from('oc_block_rules').select('*').in('block_id', blockRows.map((b) => b.id))) : [];
  return makeConfig(dept, blockRows, must(shifts), ruleRows);
}

// Also used by tests: build the config object from plain rows.
export function makeConfig(dept, blocks, shifts, ruleRows) {
  const rules = {};
  for (const r of ruleRows) (rules[r.block_id] ||= {})[r.shift_id] = r.access;
  const hospital = dept.hospital || {};
  return {
    id: dept.id,
    dept,
    hospital,
    org: hospital.org || {},
    tz: hospital.timezone || 'America/New_York',
    name: dept.name,
    fullName: hospital.name ? `${dept.name} · ${hospital.name}` : dept.name,
    blocks: blocks.map((b) => ({ ...b, start_time: hhmm(b.start_time), end_time: hhmm(b.end_time) })),
    shifts,
    rules,
  };
}

export const activeBlocks = (cfg) => cfg.blocks.filter((b) => b.active);
export const activeShifts = (cfg) => cfg.shifts.filter((s) => s.active);
export const usesShifts = (cfg) => activeShifts(cfg).length > 0;
export const groupsOf = (cfg) => cfg.dept.groups || [];

// ---------- call times ----------

export const blockRunsOn = (block, date) => block.days.includes(isoDay(date));

export function blockTimes(block, date, tz) {
  const crosses = hhmm(block.end_time) <= hhmm(block.start_time);
  const startAt = zonedToUtc(date, block.start_time, tz);
  const endAt = zonedToUtc(crosses ? addDays(date, 1) : date, block.end_time, tz);
  return { startAt, endAt, hours: Math.round(((endAt - startAt) / 3600000) * 100) / 100 };
}

// Hours on a normal day (no clock change), for display.
export function nominalHours(block) {
  const [sh, sm] = hhmm(block.start_time).split(':').map(Number);
  const [eh, em] = hhmm(block.end_time).split(':').map(Number);
  let mins = eh * 60 + em - (sh * 60 + sm);
  if (mins <= 0) mins += 24 * 60;
  return Math.round((mins / 60) * 100) / 100;
}

export function describeBlock(b) {
  return {
    id: b.id,
    label: b.label,
    startTime: hhmm(b.start_time),
    endTime: hhmm(b.end_time),
    timeLabel: timeRangeLabel(b.start_time, b.end_time),
    days: b.days,
    daysLabel: daysLabel(b.days),
    levels: b.levels,
    hours: nominalHours(b),
    sort: b.sort,
    active: b.active,
  };
}

export function daysLabel(days) {
  const s = [...days].sort((a, b) => a - b);
  const key = s.join(',');
  if (key === '1,2,3,4,5,6,7') return 'Every day';
  if (key === '1,2,3,4,5') return 'Mon–Fri';
  if (key === '1,2,3,4,5,6') return 'Mon–Sat';
  if (key === '6,7') return 'Sat–Sun';
  return s.map((d) => DAY_NAMES[d]).join(', ');
}

export const levelLabel = (n) => LEVELS[n] || `Call ${n}`;

export function describeCall(row, cfg) {
  return {
    id: row.id,
    departmentId: cfg.id,
    departmentName: cfg.fullName,
    date: row.shift_date,
    dateLabel: formatDateLong(row.shift_date),
    blockId: row.block_id,
    blockLabel: row.block_label,
    timeLabel: rangeFromInstants(row.start_at, row.end_at, cfg.tz),
    level: row.level,
    roleLabel: levelLabel(row.level),
    startAt: row.start_at,
    endAt: row.end_at,
    hours: Number(row.hours),
  };
}

// ---------- reminders ----------

export function reminderFlags(cfg, shiftDate, startAt, now = new Date()) {
  const nowIso = now.toISOString();
  const isToday = shiftDate === todayInTz(now, cfg.tz);
  const localHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, hour: '2-digit', hourCycle: 'h23' }).format(now)) % 24;
  return {
    day_reminder_sent_at: isToday && localHour >= cfg.dept.day_reminder_hour ? nowIso : null,
    hour_reminder_sent_at: new Date(startAt).getTime() - now.getTime() <= cfg.dept.hour_reminder_minutes * 60000 ? nowIso : null,
  };
}

// ---------- periods ----------

const windowDays = (cfg, n) => (n - 1) * cfg.dept.group_gap_days + cfg.dept.signup_close_days + 1;

export function buildPeriod(cfg, { startDate, signupStart, groupOrder }) {
  const d = cfg.dept;
  const n = Math.max(1, groupOrder.length);
  const opens = [];
  for (let k = 0; k < n; k++) opens.push(zonedToUtc(addDays(signupStart, k * d.group_gap_days), hhmm(d.signup_open_time), cfg.tz).toISOString());
  return {
    department_id: cfg.id,
    start_date: startDate,
    end_date: addDays(startDate, d.period_weeks * 7 - 1),
    signup_start: signupStart,
    group_order: groupOrder,
    opens_at: opens,
    closes_at: zonedToUtc(addDays(signupStart, windowDays(cfg, n)), '00:00', cfg.tz).toISOString(),
  };
}

// 'before' → 'open' → 'vacancy' (after sign-up closes)
export function phaseOf(p, now = new Date()) {
  const t = now.getTime();
  if (t < Date.parse(p.opens_at[0])) return 'before';
  if (t < Date.parse(p.closes_at)) return 'open';
  return 'vacancy';
}

// The groups whose sign-up has opened.
export const openedGroups = (p, now = new Date()) => p.group_order.filter((_, k) => Date.parse(p.opens_at[k]) <= now.getTime());

// When a member's sign-up opens in this period. No group (or unknown group) = with the last group.
export function memberOpensAt(p, member) {
  if (!p.group_order.length) return p.opens_at[0];
  const k = p.group_order.indexOf(member?.group_name);
  return p.opens_at[k >= 0 ? k : p.opens_at.length - 1];
}

export const periodLabel = (p) => `${formatDateShort(p.start_date)} – ${formatDateShort(p.end_date)}`;
const closesText = (p, tz) => formatWhen(new Date(Date.parse(p.closes_at) - 60000).toISOString(), tz);

export function describePeriod(p, cfg, now = new Date()) {
  const phase = phaseOf(p, now);
  const opened = openedGroups(p, now);
  let phaseLabel = { before: 'Sign-up not open yet', vacancy: 'Sign-up closed · filling vacancies' }[phase];
  if (phase === 'open') {
    phaseLabel = !p.group_order.length ? 'Sign-up open'
      : opened.length === p.group_order.length ? 'Open for all groups'
      : `Open for Group ${opened.join(', ')}`;
  }
  return {
    id: p.id,
    startDate: p.start_date,
    endDate: p.end_date,
    label: periodLabel(p),
    signupStart: p.signup_start,
    groupOrder: p.group_order,
    opens: p.opens_at.map((at, k) => ({ group: p.group_order[k] || null, at, label: formatWhen(at, cfg.tz) })),
    closesLabel: closesText(p, cfg.tz),
    phase,
    phaseLabel,
  };
}

export const periodFor = (periods, date) => periods.find((p) => p.start_date <= date && date <= p.end_date) || null;

export async function loadPeriods(deptId, { from, to } = {}) {
  let q = db().from('oc_periods').select('*').eq('department_id', deptId).order('start_date', { ascending: true });
  if (from) q = q.gte('end_date', from);
  if (to) q = q.lte('start_date', to);
  return must(await q);
}

export function validateNewPeriod(cfg, { startDate, signupStart, groupOrder }, existing, today) {
  const errors = [];
  const groups = groupsOf(cfg);
  if (!cfg.dept.use_periods) errors.push('This department signs up any time; it does not use periods.');
  if (startDate < today) errors.push('The start date is in the past.');
  if (groups.length) {
    const same = groupOrder.length === groups.length && [...groupOrder].sort().join() === [...groups].sort().join();
    if (!same) errors.push(`Put every group in order once: ${groups.join(', ')}.`);
  } else if (groupOrder.length) errors.push('This department has no groups.');
  const n = Math.max(1, groupOrder.length);
  if (addDays(signupStart, windowDays(cfg, n)) > startDate) {
    errors.push(`Sign-up must finish before the period starts. With these settings it runs ${windowDays(cfg, n)} day(s) from the sign-up start date.`);
  }
  const end = addDays(startDate, cfg.dept.period_weeks * 7 - 1);
  const clash = existing.find((p) => startDate <= p.end_date && end >= p.start_date);
  if (clash) errors.push(`It overlaps the period ${periodLabel(clash)}.`);
  return errors;
}

export const rotate = (order) => (order.length > 1 ? [...order.slice(1), order[0]] : [...order]);

// Next period: starts the day after the last one ends (or the Monday after next); sign-up about a
// week before; the group order rotates by one.
export function suggestNext(cfg, periods, today) {
  const last = [...periods].sort((a, b) => (a.start_date < b.start_date ? 1 : -1))[0];
  let start = last ? addDays(last.end_date, 1) : addDays(mondayOf(today), 14);
  while (start < today) start = addDays(start, cfg.dept.period_weeks * 7);
  const groups = groupsOf(cfg);
  const lastOrder = last?.group_order?.length === groups.length ? last.group_order : null;
  const order = groups.length ? (lastOrder ? rotate(lastOrder) : [...groups]) : [];
  const w = windowDays(cfg, Math.max(1, order.length));
  let signup = addDays(start, -(7 + w));
  if (signup < today) signup = addDays(start, -w);
  if (signup < today) signup = today;
  return { startDate: start, signupStart: signup, groupOrder: order };
}

// ---------- who can take what ----------

export function shiftNamesFor(cfg, blockId, access) {
  const r = cfg.rules[blockId] || {};
  return activeShifts(cfg).filter((s) => (access ? r[s.id] === access : r[s.id])).map((s) => s.name);
}

// Can this member take this slot now? Returns { ok } or { ok: false, reason, short }.
export function canTake({ cfg, period, now = new Date(), member, block, level, date }) {
  const no = (reason, short) => ({ ok: false, reason, short });
  const d = cfg.dept;
  if (!block || !block.active || !blockRunsOn(block, date)) return no('That call is not available.', 'Not available');
  if (!(level >= 1 && level <= block.levels)) return no('That call slot does not exist.', 'Not available');
  if (!member) return no('You are not on the staff list for this department.', 'Staff only');

  let access = 'signup';
  if (usesShifts(cfg)) {
    if (!member.shift_id) return no('Ask your nurse manager to set your shift before signing up.', 'Shift not set');
    access = cfg.rules[block.id]?.[member.shift_id];
    if (!access) {
      const allowed = shiftNamesFor(cfg, block.id);
      return no(
        allowed.length ? `${block.label} is for ${allowed.join(' / ')} staff.` : `${block.label} isn't open to any shift yet.`,
        allowed.length ? `${allowed.join(' / ')} staff` : 'Not available',
      );
    }
  }

  if (d.use_periods) {
    if (!period) return no('Sign-up for these dates has not been opened yet.', 'Not open yet');
    const phase = phaseOf(period, now);
    const mine = memberOpensAt(period, member);
    if (Date.parse(mine) > now.getTime() && phase !== 'vacancy') {
      const first = period.group_order[0];
      const reason = phase === 'before' && (!period.group_order.length || mine === period.opens_at[0])
        ? `Sign-up opens ${formatWhen(mine, cfg.tz)}.`
        : `Group ${first} signs up first. Your sign-up opens ${formatWhen(mine, cfg.tz)}.`;
      return no(reason, `Opens ${formatShortWhen(mine, cfg.tz)}`);
    }
    if (access === 'after_close' && phase !== 'vacancy') {
      return no(`You can take open ${block.label} slots after sign-up closes (${closesText(period, cfg.tz)}).`, 'After sign-up closes');
    }
  } else {
    const today = todayInTz(now, cfg.tz);
    if (date > addDays(today, d.book_weeks_ahead * 7)) {
      return no(`You can sign up up to ${d.book_weeks_ahead} weeks ahead.`, 'Not open yet');
    }
    if (access === 'after_close' && date > addDays(today, d.vacancy_open_days)) {
      const opens = addDays(date, -d.vacancy_open_days);
      return no(`Open ${block.label} slots open to your shift ${d.vacancy_open_days} days before the call (${formatDateShort(opens)}).`, `Opens ${formatDateShort(opens).replace(/, \d{4}$/, '')}`);
    }
  }
  return { ok: true };
}

// Can this member receive this call in a switch? (Approval rules still apply.)
export function canReceive(cfg, member, block) {
  if (!member || !block) return false;
  if (!usesShifts(cfg)) return true;
  return Boolean(member.shift_id && cfg.rules[block.id]?.[member.shift_id]);
}

// Open (unfilled, not started) slots in a period for blocks some shift can fill after close.
// Returns { total, byShift: { shiftId: count } }.
export function openSlotsAfterClose(cfg, period, takenRows, now = new Date()) {
  const taken = new Set(takenRows.map((r) => `${r.block_id}|${r.shift_date}|${r.level}`));
  const byShift = {};
  let total = 0;
  for (const b of activeBlocks(cfg)) {
    const shifts = usesShifts(cfg) ? activeShifts(cfg).filter((s) => cfg.rules[b.id]?.[s.id] === 'after_close').map((s) => s.id) : [];
    if (usesShifts(cfg) && !shifts.length) continue;
    for (let day = period.start_date; day <= period.end_date; day = addDays(day, 1)) {
      if (!blockRunsOn(b, day)) continue;
      if (blockTimes(b, day, cfg.tz).startAt <= now) continue;
      for (let lv = 1; lv <= b.levels; lv++) {
        if (taken.has(`${b.id}|${day}|${lv}`)) continue;
        total++;
        for (const s of shifts) byShift[s] = (byShift[s] || 0) + 1;
      }
    }
  }
  return { total, byShift };
}

// Total slots in a date range (for the hours report).
export function slotCount(cfg, from, to) {
  let n = 0;
  for (const b of activeBlocks(cfg)) for (let day = from; day <= to; day = addDays(day, 1)) if (blockRunsOn(b, day)) n += b.levels;
  return n;
}

export async function hoursFor(userId, deptId, from, to) {
  const rows = must(await db().from('oc_signups').select('hours').eq('user_id', userId).eq('department_id', deptId).gte('shift_date', from).lte('shift_date', to));
  return rows.reduce((a, r) => a + Number(r.hours), 0);
}

// Settings as the page shows them.
export function describeSettings(cfg) {
  const d = cfg.dept;
  return {
    id: cfg.id,
    name: d.name,
    active: d.active,
    hospital: { id: cfg.hospital.id, name: cfg.hospital.name, state: cfg.hospital.state, timezone: cfg.tz, timezoneLabel: TIME_ZONES[cfg.tz] || cfg.tz },
    org: { id: cfg.org.id, name: cfg.org.name },
    usePeriods: d.use_periods,
    periodWeeks: d.period_weeks,
    minHours: Number(d.min_hours),
    groups: d.groups,
    groupGapDays: d.group_gap_days,
    signupOpenTime: hhmm(d.signup_open_time),
    signupCloseDays: d.signup_close_days,
    bookWeeksAhead: d.book_weeks_ahead,
    vacancyOpenDays: d.vacancy_open_days,
    cancelCutoffHours: d.cancel_cutoff_hours,
    dayReminderHour: d.day_reminder_hour,
    hourReminderMinutes: d.hour_reminder_minutes,
    switchNeedsApproval: d.switch_needs_approval,
    blocks: cfg.blocks.map(describeBlock),
    shifts: cfg.shifts.map((s) => ({ id: s.id, name: s.name, sort: s.sort, active: s.active })),
    rules: cfg.rules,
  };
}
