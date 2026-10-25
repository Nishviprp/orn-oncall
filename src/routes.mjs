// Staff API: schedule board, sign-up, my calls, switches. Every route except /config needs sign-in.
import {
  HttpError, json, readJson, db, must, env, settings, getProfile, contactFor, notify, personFor, namesFor, needUuid, cleanText,
  isValidDateStr, todayInTz, mondayOf, addDays, formatDateLong, matchesContact,
} from './lib.mjs';
import {
  loadDept, activeBlocks, blockRunsOn, blockTimes, describeCall, describePeriod, periodFor, loadPeriods, canTake, canReceive,
  reminderFlags, levelLabel, periodLabel, hoursFor, usesShifts, daysLabel,
} from './dept.mjs';
import { getAccess, memberOf, canManage, requireSeeDept, visibleDepartments, managedDeptIds, isAnyAdmin, mergeMembers } from './access.mjs';
import { buildMessage } from './messages.mjs';
import { MANAGE_ROUTES } from './manage.mjs';
import { ADMIN_ROUTES } from './admin.mjs';

const OPEN_SWAP = ['pending_colleague', 'pending_manager'];
const DAY_MS = 86400000;

export function deptParam(req) {
  return needUuid(new URL(req.url).searchParams.get('d'), 'department');
}

// Cache department configs for one request.
function cfgCache() {
  const m = new Map();
  return (id) => {
    if (!m.has(id)) m.set(id, loadDept(id));
    return m.get(id);
  };
}

// ---------- config and profile ----------

async function config() {
  const e = env();
  if (!e.SUPABASE_URL || !e.SUPABASE_ANON_KEY) {
    return json(500, { error: 'The ON CALL page is not set up yet (missing Supabase settings).' });
  }
  return json(200, { supabaseUrl: e.SUPABASE_URL, supabaseAnonKey: e.SUPABASE_ANON_KEY, phoneLogin: settings().phoneLogin });
}

async function me(req) {
  const a = await getAccess(req);
  const { user, contact } = a;
  if (req.method === 'POST') {
    const body = await readJson(req);
    const full_name = cleanText(body.full_name, 100);
    if (!full_name || full_name.length < 2) throw new HttpError(400, 'Please enter your full name.');
    must(await db().from('oc_profiles').upsert({ id: user.id, full_name, email: contact.email, phone: contact.phone, updated_at: new Date().toISOString() }));
  }
  let profile = await getProfile(user.id);
  if (profile && (profile.email !== contact.email || profile.phone !== contact.phone)) {
    must(await db().from('oc_profiles').update({ email: contact.email, phone: contact.phone }).eq('id', user.id));
  }
  const departments = await visibleDepartments(a);
  const managed = departments.filter((d) => d.canManage).map((d) => d.id);
  return json(200, {
    contact,
    fullName: profile?.full_name || null,
    departments,
    admin: { system: a.system, orgIds: a.orgIds, hospitalIds: a.hospitalIds, any: isAnyAdmin(a) },
    pendingSwitches: await countPending(user.id, managed),
  });
}

async function countPending(userId, managedIds) {
  const nowIso = new Date().toISOString();
  const r1 = await db().from('oc_swaps').select('id', { count: 'exact', head: true }).eq('to_user', userId).eq('status', 'pending_colleague').gt('start_at', nowIso);
  if (r1.error) throw r1.error;
  let n = r1.count || 0;
  if (managedIds.length) {
    const r2 = await db().from('oc_swaps').select('id', { count: 'exact', head: true }).in('department_id', managedIds).eq('status', 'pending_manager').gt('start_at', nowIso);
    if (r2.error) throw r2.error;
    n += r2.count || 0;
  }
  return n;
}

// ---------- schedule board ----------

async function slots(req) {
  const a = await getAccess(req);
  const cfg = await loadDept(deptParam(req));
  requireSeeDept(a, cfg);
  const member = memberOf(a, cfg.id);
  const manager = canManage(a, cfg);
  const d = cfg.dept;
  const now = new Date();
  const today = todayInTz(now, cfg.tz);
  const asked = new URL(req.url).searchParams.get('week');
  const thisMonday = mondayOf(today);
  let monday = mondayOf(isValidDateStr(asked) ? asked : today);
  if (monday < thisMonday) monday = thisMonday;
  const sunday = addDays(monday, 6);

  const [rows, periods, future] = await Promise.all([
    db().from('oc_signups').select('id, block_id, shift_date, level, user_id').eq('department_id', cfg.id).gte('shift_date', monday).lte('shift_date', sunday),
    loadPeriods(cfg.id, { from: monday, to: sunday }),
    d.use_periods ? loadPeriods(cfg.id, { from: today }) : Promise.resolve([]),
  ]);
  const taken = must(rows);
  const names = manager ? await namesFor(taken.map((r) => r.user_id)) : {};
  const byKey = new Map(taken.map((r) => [`${r.block_id}|${r.shift_date}|${r.level}`, r]));
  const blocks = activeBlocks(cfg);
  const shiftName = member?.shift_id ? cfg.shifts.find((s) => s.id === member.shift_id)?.name : null;

  const days = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(monday, i);
    if (date < today) continue; // past days aren't shown
    const dayBlocks = blocks.filter((b) => blockRunsOn(b, date));
    if (!dayBlocks.length) continue;
    const period = periodFor(periods, date);
    days.push({
      date,
      label: formatDateLong(date),
      blocks: dayBlocks.map((b) => {
        const t = blockTimes(b, date, cfg.tz);
        const started = t.startAt <= now;
        const roles = [];
        for (let level = 1; level <= b.levels; level++) {
          const row = byKey.get(`${b.id}|${date}|${level}`);
          const out = { level, label: levelLabel(level) };
          if (row) out.status = row.user_id === a.user.id ? 'mine' : 'taken';
          else if (started) out.status = 'past';
          else if (!member) { out.status = 'locked'; out.note = manager ? 'Open' : 'Staff only'; }
          else {
            const ok = canTake({ cfg, period, now, member, block: b, level, date });
            out.status = ok.ok ? 'open' : 'locked';
            if (!ok.ok) { out.note = ok.short; out.reason = ok.reason; }
          }
          if (row && out.status === 'mine') out.id = row.id;
          if (row && manager) out.name = names[row.user_id] || 'Nurse';
          roles.push(out);
        }
        return { blockId: b.id, label: b.label, timeLabel: describeTime(t, cfg), hours: t.hours, roles };
      }),
    });
  }

  const lastBookable = d.use_periods ? (future.length ? future[future.length - 1].end_date : null) : addDays(today, d.book_weeks_ahead * 7);
  const periodViews = [];
  for (const p of periods) {
    periodViews.push({ ...describePeriod(p, cfg, now), yourHours: member ? await hoursFor(a.user.id, cfg.id, p.start_date, p.end_date) : 0 });
  }
  return json(200, {
    department: { id: cfg.id, name: cfg.name, fullName: cfg.fullName, usePeriods: d.use_periods, minHours: Number(d.min_hours), timezone: cfg.tz },
    weekStart: monday,
    weekLabel: `${formatDateLong(monday)} – ${formatDateLong(sunday)}`,
    prevWeek: monday > thisMonday ? addDays(monday, -7) : null,
    nextWeek: lastBookable && addDays(monday, 7) <= lastBookable ? addDays(monday, 7) : null,
    manager,
    member: Boolean(member),
    you: member ? { group: member.group_name, shiftName } : null,
    usesShifts: usesShifts(cfg),
    groups: d.groups,
    periods: periodViews,
    upcomingPeriods: future.map((p) => describePeriod(p, cfg, now)),
    blocksSummary: blocks.map((b) => ({ label: b.label, days: daysLabel(b.days), levels: b.levels })),
    days,
  });
}

const describeTime = (t, cfg) => {
  const f = (dt) => new Intl.DateTimeFormat('en-US', { timeZone: cfg.tz, hour: 'numeric', minute: '2-digit' }).format(dt);
  const sameDay = todayInTz(t.startAt, cfg.tz) === todayInTz(t.endAt, cfg.tz);
  return `${f(t.startAt)} – ${f(t.endAt)}${sameDay ? '' : ' (next day)'}`;
};

async function book(req) {
  const a = await getAccess(req);
  const body = await readJson(req);
  const blockId = needUuid(body.blockId, 'call time');
  const date = body.date;
  const level = Number(body.level);
  if (!isValidDateStr(date)) throw new HttpError(400, 'Invalid date.');

  const blockRow = must(await db().from('oc_blocks').select('department_id').eq('id', blockId).maybeSingle());
  if (!blockRow) throw new HttpError(404, 'Call time not found.');
  const cfg = await loadDept(blockRow.department_id);
  const member = memberOf(a, cfg.id);
  if (!member) throw new HttpError(403, 'You are not on the staff list for this department.');
  const profile = await getProfile(a.user.id);
  if (!profile) throw new HttpError(400, 'Please add your name on the Account tab first.');
  if (!cfg.dept.active) throw new HttpError(403, 'This department is not active.');

  const block = cfg.blocks.find((b) => b.id === blockId);
  const now = new Date();
  const t = blockTimes(block, date, cfg.tz);
  if (t.startAt <= now) throw new HttpError(400, 'That call has already started or passed.');
  const periods = cfg.dept.use_periods ? await loadPeriods(cfg.id, { from: date, to: date }) : [];
  const period = periodFor(periods, date);
  const ok = canTake({ cfg, period, now, member, block, level, date });
  if (!ok.ok) throw new HttpError(403, ok.reason);

  const res = await db().from('oc_signups').insert({
    department_id: cfg.id, block_id: block.id, user_id: a.user.id, shift_date: date, level,
    block_label: block.label, start_at: t.startAt.toISOString(), end_at: t.endAt.toISOString(), hours: t.hours,
    ...reminderFlags(cfg, date, t.startAt, now),
  }).select('*').single();
  if (res.error) {
    if (res.error.code === '23505') throw new HttpError(409, 'Sorry, someone just took that slot. Please pick another.');
    if (res.error.code === '23P01') throw new HttpError(409, 'You already have a call that overlaps this time.');
    throw res.error;
  }

  const call = describeCall(res.data, cfg);
  let ctx = {};
  if (period) {
    ctx = { hours: await hoursFor(a.user.id, cfg.id, period.start_date, period.end_date), minHours: Number(cfg.dept.min_hours), periodLabel: periodLabel(period) };
  }
  const sent = await notify(contactFor(a.user), buildMessage('confirm', profile.full_name, call, ctx));
  return json(200, { call, sent, hours: ctx.hours, minHours: ctx.minHours });
}

async function release(req) {
  const a = await getAccess(req);
  const id = needUuid((await readJson(req)).id, 'call');
  const row = must(await db().from('oc_signups').select('*').eq('id', id).eq('user_id', a.user.id).maybeSingle());
  if (!row) throw new HttpError(404, 'Call not found.');
  const cfg = await loadDept(row.department_id);
  const hours = cfg.dept.cancel_cutoff_hours;
  if (new Date(row.start_at).getTime() - Date.now() < hours * 3600000) {
    throw new HttpError(400, `Calls can only be released more than ${hours} hours ahead. Please contact your nurse manager, or give it to a colleague.`);
  }
  const open = must(await db().from('oc_swaps').select('id').eq('signup_id', id).in('status', OPEN_SWAP).limit(1));
  if (open.length) throw new HttpError(409, 'This call has a switch in progress. Cancel the switch first.');
  must(await db().from('oc_signups').delete().eq('id', id).eq('user_id', a.user.id));
  const profile = await getProfile(a.user.id);
  const call = describeCall(row, cfg);
  return json(200, { released: call, sent: await notify(contactFor(a.user), buildMessage('cancel', profile?.full_name, call)) });
}

async function myCalls(req) {
  const a = await getAccess(req);
  const now = Date.now();
  const rows = must(await db().from('oc_signups').select('*').eq('user_id', a.user.id)
    .gte('end_at', new Date(now - 30 * DAY_MS).toISOString()).order('start_at', { ascending: true }));
  const cfgOf = cfgCache();

  const swaps = rows.length ? must(await db().from('oc_swaps').select('id, signup_id, status, to_user').in('signup_id', rows.map((r) => r.id)).in('status', OPEN_SWAP)) : [];
  const names = await namesFor(swaps.map((s) => s.to_user));
  const bySignup = Object.fromEntries(swaps.map((s) => [s.signup_id, s]));

  const calls = [];
  for (const row of rows) {
    const cfg = await cfgOf(row.department_id);
    const start = new Date(row.start_at).getTime();
    const sw = bySignup[row.id];
    calls.push({
      ...describeCall(row, cfg),
      upcoming: new Date(row.end_at).getTime() > now,
      canRelease: start - now >= cfg.dept.cancel_cutoff_hours * 3600000 && !sw,
      canGiveAway: start > now && !sw,
      stayStatus: row.stay_status,
      stayNote: row.stay_note,
      swap: sw ? { id: sw.id, status: sw.status, toName: names[sw.to_user] || 'Colleague' } : null,
    });
  }

  // Progress toward minimum hours for each department the person is staff in that uses periods.
  const progress = [];
  for (const deptId of Object.keys(a.members)) {
    let cfg;
    try { cfg = await cfgOf(deptId); } catch { continue; }
    if (!cfg.dept.use_periods || !cfg.dept.active) continue;
    const today = todayInTz(new Date(now), cfg.tz);
    for (const p of await loadPeriods(cfg.id, { from: today })) {
      const h = await hoursFor(a.user.id, cfg.id, p.start_date, p.end_date);
      const min = Number(cfg.dept.min_hours);
      progress.push({ id: p.id, department: cfg.fullName, label: periodLabel(p), current: p.start_date <= today, hours: h, minHours: min, met: h >= min });
    }
  }
  const profile = await getProfile(a.user.id);
  return json(200, { fullName: profile?.full_name || null, calls, progress });
}

// ---------- switches ----------

// Staff of a department who have signed in, with their merged staff row.
export async function signedInStaff(cfg, excludeUserId) {
  const [memberRows, profiles] = await Promise.all([
    db().from('oc_members').select('*').eq('department_id', cfg.id),
    db().from('oc_profiles').select('id, full_name, email, phone').order('full_name'),
  ]);
  const rows = must(memberRows);
  return must(profiles)
    .filter((p) => p.id !== excludeUserId)
    .map((p) => ({ ...p, member: mergeMembers(rows.filter((r) => matchesContact(r, p)))[cfg.id] || null }))
    .filter((p) => p.member);
}

async function colleagues(req) {
  const a = await getAccess(req);
  const signupId = needUuid(new URL(req.url).searchParams.get('signupId'), 'call');
  const row = must(await db().from('oc_signups').select('department_id, block_id').eq('id', signupId).eq('user_id', a.user.id).maybeSingle());
  if (!row) throw new HttpError(404, 'Call not found.');
  const cfg = await loadDept(row.department_id);
  const block = cfg.blocks.find((b) => b.id === row.block_id);
  const list = (await signedInStaff(cfg, a.user.id)).filter((p) => canReceive(cfg, p.member, block));
  const shiftName = (id) => cfg.shifts.find((s) => s.id === id)?.name || null;
  return json(200, { colleagues: list.map((p) => ({ id: p.id, name: p.full_name, shiftName: shiftName(p.member.shift_id) })) });
}

async function hasOverlap(userId, startAt, endAt) {
  const rows = must(await db().from('oc_signups').select('id').eq('user_id', userId).lt('start_at', endAt).gt('end_at', startAt).limit(1));
  return rows.length > 0;
}

const swapCall = (s, cfg) => describeCall({ id: s.signup_id, shift_date: s.shift_date, block_id: s.block_id, block_label: s.block_label, level: s.level, start_at: s.start_at, end_at: s.end_at, hours: 0 }, cfg);

async function swapRequest(req) {
  const a = await getAccess(req);
  const body = await readJson(req);
  const signupId = needUuid(body.signupId, 'call');
  const toUserId = needUuid(body.toUserId, 'colleague');
  if (toUserId === a.user.id) throw new HttpError(400, 'Choose a colleague other than yourself.');
  const note = cleanText(body.note, 300);

  const signup = must(await db().from('oc_signups').select('*').eq('id', signupId).eq('user_id', a.user.id).maybeSingle());
  if (!signup) throw new HttpError(404, 'Call not found.');
  if (new Date(signup.start_at) <= new Date()) throw new HttpError(400, 'This call has already started.');
  const cfg = await loadDept(signup.department_id);
  const profile = await getProfile(a.user.id);
  if (!profile || !memberOf(a, cfg.id)) throw new HttpError(403, 'You are not on the staff list for this department.');

  const block = cfg.blocks.find((b) => b.id === signup.block_id);
  const colleague = (await signedInStaff(cfg, a.user.id)).find((p) => p.id === toUserId);
  if (!colleague) throw new HttpError(400, 'That colleague is not on this department\'s staff list.');
  if (!canReceive(cfg, colleague.member, block)) throw new HttpError(400, `${colleague.full_name} can't take ${block.label} call with their shift.`);
  if (await hasOverlap(toUserId, signup.start_at, signup.end_at)) throw new HttpError(409, `${colleague.full_name} already has a call at that time.`);

  const ins = await db().from('oc_swaps').insert({
    department_id: cfg.id, signup_id: signup.id, from_user: a.user.id, to_user: toUserId, note,
    shift_date: signup.shift_date, block_id: signup.block_id, level: signup.level, block_label: signup.block_label,
    start_at: signup.start_at, end_at: signup.end_at,
  }).select('*').single();
  if (ins.error) {
    if (ins.error.code === '23505') throw new HttpError(409, 'This call already has a switch request in progress.');
    throw ins.error;
  }
  const to = await personFor(toUserId);
  const sent = await notify(to.contact, buildMessage('swap_request', to.name, swapCall(ins.data, cfg), { from: profile.full_name, note, needsApproval: cfg.dept.switch_needs_approval }));
  return json(200, { swapId: ins.data.id, sent });
}

async function claimSwap(id, fromStatus, patch) {
  const rows = must(await db().from('oc_swaps').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('status', fromStatus).select('*'));
  return rows[0] || null;
}

async function runApproval(swap, cfg, managerId) {
  const flags = reminderFlags(cfg, swap.shift_date, swap.start_at, new Date());
  const { error } = await db().rpc('oc_approve_swap', {
    p_swap: swap.id, p_manager: managerId, p_day_sent: flags.day_reminder_sent_at, p_hour_sent: flags.hour_reminder_sent_at,
  });
  if (error) {
    const m = String(error.message || '');
    if (error.code === '23P01' || error.code === '23505') throw new HttpError(409, 'The colleague already has a call at that time, so this switch can\'t go through.');
    if (m.includes('SWAP_NOT_PENDING')) throw new HttpError(409, 'This switch was already handled.');
    if (m.includes('SIGNUP_CHANGED')) throw new HttpError(409, 'This call has changed or already started, so it can no longer be switched.');
    throw error;
  }
}

async function swapRespond(req) {
  const a = await getAccess(req);
  const body = await readJson(req);
  const swapId = needUuid(body.swapId, 'switch');
  const swap = must(await db().from('oc_swaps').select('*').eq('id', swapId).eq('to_user', a.user.id).maybeSingle());
  if (!swap) throw new HttpError(404, 'Switch request not found.');
  if (swap.status !== 'pending_colleague') throw new HttpError(409, 'This request was already handled.');
  if (new Date(swap.start_at) <= new Date()) throw new HttpError(400, 'This call has already started.');
  const cfg = await loadDept(swap.department_id);
  const [from, to] = await Promise.all([personFor(swap.from_user), personFor(a.user.id)]);
  const call = swapCall(swap, cfg);

  if (body.accept) {
    const member = memberOf(a, cfg.id);
    const block = cfg.blocks.find((b) => b.id === swap.block_id);
    if (!canReceive(cfg, member, block)) throw new HttpError(403, `You can't take ${swap.block_label} call with your shift.`);
    if (await hasOverlap(a.user.id, swap.start_at, swap.end_at)) throw new HttpError(409, 'You already have a call at that time.');

    if (!cfg.dept.switch_needs_approval) {
      await runApproval(swap, cfg, null);
      const ctx = { from: from.name, to: to.name };
      await Promise.all([
        notify(from.contact, buildMessage('swap_confirmed_from', from.name, call, ctx)),
        notify(to.contact, buildMessage('swap_confirmed_to', to.name, call, ctx)),
      ]);
      return json(200, { status: 'approved' });
    }

    const updated = await claimSwap(swap.id, 'pending_colleague', { status: 'pending_manager', colleague_response_at: new Date().toISOString() });
    if (!updated) throw new HttpError(409, 'This request was already handled.');
    const managers = must(await db().from('oc_members').select('full_name, email, phone').eq('department_id', cfg.id).eq('is_manager', true));
    await Promise.all([
      notify(from.contact, buildMessage('swap_accepted', from.name, call, { to: to.name })),
      ...managers.map((m) => notify({ email: m.email, phone: m.phone }, buildMessage('swap_manager', m.full_name, call, { from: from.name, to: to.name }))),
    ]);
    return json(200, { status: 'pending_manager', managersNotified: managers.length });
  }

  const updated = await claimSwap(swap.id, 'pending_colleague', { status: 'declined', colleague_response_at: new Date().toISOString() });
  if (!updated) throw new HttpError(409, 'This request was already handled.');
  await notify(from.contact, buildMessage('swap_declined', from.name, call, { to: to.name }));
  return json(200, { status: 'declined' });
}

async function swapDecide(req) {
  const a = await getAccess(req);
  const body = await readJson(req);
  const swapId = needUuid(body.swapId, 'switch');
  const note = cleanText(body.note, 300);
  const swap = must(await db().from('oc_swaps').select('*').eq('id', swapId).maybeSingle());
  if (!swap) throw new HttpError(404, 'Switch request not found.');
  const cfg = await loadDept(swap.department_id);
  if (!canManage(a, cfg)) throw new HttpError(403, 'Only a manager of this department can approve switches.');
  if (swap.status !== 'pending_manager') throw new HttpError(409, 'This switch was already handled.');
  if (swap.from_user === a.user.id || swap.to_user === a.user.id) throw new HttpError(403, 'Another manager needs to approve a switch you are part of.');

  const [from, to] = await Promise.all([personFor(swap.from_user), personFor(swap.to_user)]);
  const call = swapCall(swap, cfg);
  const ctx = { from: from.name, to: to.name, note };
  if (body.approve) {
    await runApproval(swap, cfg, a.user.id);
    if (note) must(await db().from('oc_swaps').update({ manager_note: note }).eq('id', swap.id));
    const sent = await Promise.all([
      notify(from.contact, buildMessage('swap_approved_from', from.name, call, ctx)),
      notify(to.contact, buildMessage('swap_approved_to', to.name, call, ctx)),
    ]);
    return json(200, { status: 'approved', sent });
  }
  const updated = await claimSwap(swap.id, 'pending_manager', { status: 'denied', manager_id: a.user.id, manager_response_at: new Date().toISOString(), manager_note: note });
  if (!updated) throw new HttpError(409, 'This switch was already handled.');
  await Promise.all([
    notify(from.contact, buildMessage('swap_denied', from.name, call, ctx)),
    notify(to.contact, buildMessage('swap_denied', to.name, call, ctx)),
  ]);
  return json(200, { status: 'denied' });
}

async function swapCancel(req) {
  const a = await getAccess(req);
  const swapId = needUuid((await readJson(req)).swapId, 'switch');
  const swap = must(await db().from('oc_swaps').select('*').eq('id', swapId).eq('from_user', a.user.id).maybeSingle());
  if (!swap) throw new HttpError(404, 'Switch request not found.');
  const updated = OPEN_SWAP.includes(swap.status) ? await claimSwap(swap.id, swap.status, { status: 'cancelled' }) : null;
  if (!updated) throw new HttpError(409, 'This switch can no longer be cancelled.');
  const cfg = await loadDept(swap.department_id);
  const [from, to] = await Promise.all([personFor(swap.from_user), personFor(swap.to_user)]);
  await notify(to.contact, buildMessage('swap_cancelled', to.name, swapCall(swap, cfg), { from: from.name }));
  return json(200, { status: 'cancelled' });
}

const STATUS_LABEL = {
  pending_colleague: 'Waiting for colleague',
  pending_manager: 'Waiting for manager approval',
  approved: 'Approved',
  declined: 'Declined by colleague',
  denied: 'Not approved by manager',
  cancelled: 'Cancelled',
  expired: 'Expired (call started)',
};

async function swapsList(req) {
  const a = await getAccess(req);
  const uid = a.user.id;
  const managed = await managedDeptIds(a);
  const nowIso = new Date().toISOString();
  const since = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const q = [
    db().from('oc_swaps').select('*').eq('to_user', uid).eq('status', 'pending_colleague').gt('start_at', nowIso).order('start_at'),
    db().from('oc_swaps').select('*').eq('from_user', uid).gte('updated_at', since).order('updated_at', { ascending: false }).limit(50),
    db().from('oc_swaps').select('*').eq('to_user', uid).neq('status', 'pending_colleague').gte('updated_at', since).order('updated_at', { ascending: false }).limit(50),
  ];
  if (managed.length) {
    q.push(db().from('oc_swaps').select('*').in('department_id', managed).eq('status', 'pending_manager').gt('start_at', nowIso).order('start_at'));
    q.push(db().from('oc_swaps').select('*').in('department_id', managed).in('status', ['approved', 'denied']).gte('updated_at', since).order('updated_at', { ascending: false }).limit(50));
  }
  const res = (await Promise.all(q)).map(must);
  const [incoming, sent, received, approvals = [], decided = []] = res;
  const mine = [...sent, ...received].sort((x, y) => (x.updated_at < y.updated_at ? 1 : -1));
  const all = [...incoming, ...mine, ...approvals, ...decided];
  const names = await namesFor(all.flatMap((s) => [s.from_user, s.to_user, s.manager_id]));
  const cfgOf = cfgCache();
  const view = async (s) => ({
    id: s.id,
    call: swapCall(s, await cfgOf(s.department_id)),
    status: s.status,
    statusLabel: STATUS_LABEL[s.status] || s.status,
    fromName: names[s.from_user] || 'Colleague',
    toName: names[s.to_user] || 'Colleague',
    managerName: s.manager_id ? names[s.manager_id] || 'Manager' : null,
    note: s.note,
    managerNote: s.manager_note,
    iAmFrom: s.from_user === uid,
    involvesMe: s.from_user === uid || s.to_user === uid,
  });
  const mapAll = (list) => Promise.all(list.map(view));
  return json(200, {
    manager: managed.length > 0,
    incoming: await mapAll(incoming),
    mine: await mapAll(mine),
    approvals: await mapAll(approvals),
    decided: await mapAll(decided),
  });
}

// ---------- router ----------

const ROUTES = {
  'GET /api/oncall/config': config,
  'GET /api/oncall/me': me,
  'POST /api/oncall/me': me,
  'GET /api/oncall/slots': slots,
  'POST /api/oncall/book': book,
  'POST /api/oncall/cancel': release,
  'GET /api/oncall/my-calls': myCalls,
  'GET /api/oncall/colleagues': colleagues,
  'GET /api/oncall/switches': swapsList,
  'POST /api/oncall/switches/request': swapRequest,
  'POST /api/oncall/switches/respond': swapRespond,
  'POST /api/oncall/switches/decide': swapDecide,
  'POST /api/oncall/switches/cancel': swapCancel,
  ...MANAGE_ROUTES,
  ...ADMIN_ROUTES,
};

export const ROUTE_KEYS = Object.keys(ROUTES);

export async function handleApi(req) {
  const { pathname } = new URL(req.url);
  const path = pathname.replace(/\/$/, '');
  const route = ROUTES[`${req.method} ${path}`];
  if (!route) {
    const known = ROUTE_KEYS.some((k) => k.endsWith(' ' + path));
    return json(known ? 405 : 404, { error: known ? 'Method not allowed.' : 'Not found.' });
  }
  if (req.method === 'POST') {
    const origin = req.headers.get('origin');
    if (origin && origin !== new URL(req.url).origin) return json(403, { error: 'Request blocked.' });
  }
  try {
    return await route(req);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { error: e.message });
    console.error(e);
    return json(500, { error: 'Something went wrong. Please try again.' });
  }
}
