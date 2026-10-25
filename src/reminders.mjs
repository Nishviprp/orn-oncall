// Runs every 10 minutes (Cloudflare cron trigger), for every department in its own time zone:
//  1) Morning-of reminder (department's reminder hour) on the day of the call.
//  2) Reminder shortly before the call (department's "minutes before" setting).
//  3) Switch requests not finished before the call starts are marked expired.
//  4) "Sign-up is open" notices as each group's sign-up opens, and vacancy notices after sign-up closes.
// Each message is "claimed" in the database first, so nothing is sent twice.
import { db, must, todayInTz, hourInTz, notify, personFor, matchesContact } from './lib.mjs';
import {
  loadDept, describeCall, describePeriod, periodLabel, openSlotsAfterClose, usesShifts, activeShifts,
} from './dept.mjs';
import { buildMessage, buildNotice } from './messages.mjs';

function cache() {
  const m = new Map();
  return (id) => {
    if (!m.has(id)) m.set(id, loadDept(id).catch(() => null));
    return m.get(id);
  };
}

async function claim(table, id, column, nowIso) {
  const rows = must(await db().from(table).update({ [column]: nowIso }).eq('id', id).is(column, null).select('id'));
  return rows.length > 0;
}

export function reminderDue(kind, row, cfg, now) {
  const start = Date.parse(row.start_at);
  if (start <= now.getTime()) return false;
  if (kind === 'day') {
    return !row.day_reminder_sent_at && row.shift_date === todayInTz(now, cfg.tz) && hourInTz(now, cfg.tz) >= cfg.dept.day_reminder_hour;
  }
  const mins = cfg.dept.hour_reminder_minutes;
  return !row.hour_reminder_sent_at && mins > 0 && start - now.getTime() <= mins * 60000;
}

async function reminders(now, cfgOf, result) {
  const nowIso = now.toISOString();
  const horizon = new Date(now.getTime() + 48 * 3600000).toISOString();
  const rows = must(await db().from('oc_signups').select('*').gt('start_at', nowIso).lte('start_at', horizon)
    .or('day_reminder_sent_at.is.null,hour_reminder_sent_at.is.null'));
  for (const row of rows) {
    const cfg = await cfgOf(row.department_id);
    if (!cfg) continue;
    for (const [kind, col] of [['day', 'day_reminder_sent_at'], ['hour', 'hour_reminder_sent_at']]) {
      try {
        if (!reminderDue(kind, row, cfg, now)) continue;
        if (!(await claim('oc_signups', row.id, col, nowIso))) continue;
        const p = await personFor(row.user_id);
        await notify(p.contact, buildMessage(kind, p.name, describeCall(row, cfg), { minutes: cfg.dept.hour_reminder_minutes }));
        result[kind]++;
      } catch (e) {
        console.error(`Reminder ${kind} failed for ${row.id}`, e);
      }
    }
  }
}

async function expireSwaps(now, cfgOf, result) {
  const nowIso = now.toISOString();
  const rows = must(await db().from('oc_swaps').update({ status: 'expired', updated_at: nowIso })
    .in('status', ['pending_colleague', 'pending_manager']).lte('start_at', nowIso).select('*'));
  for (const s of rows) {
    try {
      const cfg = await cfgOf(s.department_id);
      if (!cfg) continue;
      const call = describeCall({ id: s.signup_id, shift_date: s.shift_date, block_id: s.block_id, block_label: s.block_label, level: s.level, start_at: s.start_at, end_at: s.end_at, hours: 0 }, cfg);
      const [from, to] = await Promise.all([personFor(s.from_user), personFor(s.to_user)]);
      const ctx = { from: from.name, to: to.name };
      await Promise.all([notify(from.contact, buildMessage('swap_expired', from.name, call, ctx)), notify(to.contact, buildMessage('swap_expired', to.name, call, ctx))]);
    } catch (e) {
      console.error('Expire notice failed', s.id, e);
    }
  }
  result.expiredSwitches = rows.length;
}

// Shifts that can take something during sign-up / only as vacancies.
const canSignUpAny = (cfg, shiftId) => !usesShifts(cfg) || Object.values(cfg.rules).some((r) => r[shiftId] === 'signup');

async function periodNotices(now, cfgOf, result) {
  const nowIso = now.toISOString();
  const periods = must(await db().from('oc_periods').select('*').gte('end_date', now.toISOString().slice(0, 10)));
  for (const p of periods) {
    const cfg = await cfgOf(p.department_id);
    if (!cfg || !cfg.dept.active || !cfg.dept.use_periods) continue;
    try {
      const members = must(await db().from('oc_members').select('*').eq('department_id', cfg.id)).filter((m) => m.email || m.phone);
      const view = describePeriod(p, cfg, now);
      const label = periodLabel(p);
      const closed = Date.parse(p.closes_at) <= now.getTime();
      const groupCount = Math.max(1, p.group_order.length);

      // Sign-up open notices, one group at a time, in order.
      for (let k = p.notified_count; k < groupCount && !closed; k++) {
        if (Date.parse(p.opens_at[k]) > now.getTime()) break;
        const ok = must(await db().from('oc_periods').update({ notified_count: k + 1 }).eq('id', p.id).eq('notified_count', k).select('id'));
        if (!ok.length) break;
        const group = p.group_order[k] || null;
        const lastIdx = groupCount - 1;
        const inGroup = (m) => !group || m.group_name === group || (k === lastIdx && !p.group_order.includes(m.group_name));
        for (const m of members.filter((x) => inGroup(x) && (!usesShifts(cfg) || (x.shift_id && canSignUpAny(cfg, x.shift_id))))) {
          await notify({ email: m.email, phone: m.phone }, buildNotice('signup_open', m.full_name, {
            dept: cfg.fullName, deptId: cfg.id, group, periodLabel: label, closesLabel: view.closesLabel, minHours: Number(cfg.dept.min_hours) || null,
          }));
          result.openNotices++;
        }
      }

      // Vacancy notice once, after sign-up closes.
      if (closed && !p.vacancy_notice_sent_at) {
        if (!(await claim('oc_periods', p.id, 'vacancy_notice_sent_at', nowIso))) continue;
        const taken = must(await db().from('oc_signups').select('block_id, shift_date, level').eq('department_id', cfg.id).gte('shift_date', p.start_date).lte('shift_date', p.end_date));
        const open = openSlotsAfterClose(cfg, p, taken, now);
        if (!open.total || !usesShifts(cfg)) continue;
        for (const s of activeShifts(cfg)) {
          const count = open.byShift[s.id] || 0;
          if (!count) continue;
          for (const m of members.filter((x) => x.shift_id === s.id)) {
            await notify({ email: m.email, phone: m.phone }, buildNotice('vacancies', m.full_name, { dept: cfg.fullName, deptId: cfg.id, count, periodLabel: label }));
            result.vacancyNotices++;
          }
        }
      }
    } catch (e) {
      console.error('Period notices failed', p.id, e);
    }
  }
}

export async function runReminders(now = new Date()) {
  const cfgOf = cache();
  const result = { day: 0, hour: 0, expiredSwitches: 0, openNotices: 0, vacancyNotices: 0 };
  for (const [name, fn] of [['reminders', reminders], ['switch expiry', expireSwaps], ['period notices', periodNotices]]) {
    try {
      await fn(now, cfgOf, result);
    } catch (e) {
      console.error(`ON CALL ${name} failed`, e);
    }
  }
  console.log('ON CALL scheduled run', result);
  return result;
}

