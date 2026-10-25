// Department manager API (also open to hospital, organization and system admins).
// Includes the Settings screens: general rules, call times, shifts, and who can take each call.
import {
  HttpError, json, readJson, db, must, notify, personFor, namesFor, needUuid, cleanText, normEmail, normPhone,
  isValidDateStr, isValidTime, todayInTz, addDays, formatDateLong, matchesContact, hhmm, timeRangeLabel,
} from './lib.mjs';
import {
  loadDept, describeCall, describePeriod, buildPeriod, validateNewPeriod, suggestNext, periodLabel, periodFor, loadPeriods,
  openSlotsAfterClose, slotCount, describeSettings, nominalHours, activeShifts, usesShifts, phaseOf,
} from './dept.mjs';
import { getAccess, requireManage, memberOf, adminOfHospital } from './access.mjs';
import { buildMessage } from './messages.mjs';

const deptId = (req) => needUuid(new URL(req.url).searchParams.get('d'), 'department');

async function managerCtx(req, id) {
  const a = await getAccess(req);
  const cfg = await loadDept(id || deptId(req));
  requireManage(a, cfg);
  return { a, cfg };
}

const int = (v, lo, hi, what) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new HttpError(400, `${what} must be a whole number from ${lo} to ${hi}.`);
  return n;
};
const bool = (v) => v === true || v === 'true';

// ---------- today: stay or released ----------

async function today(req) {
  const { cfg } = await managerCtx(req);
  const asked = new URL(req.url).searchParams.get('date');
  const date = isValidDateStr(asked) ? asked : todayInTz(new Date(), cfg.tz);
  const rows = must(await db().from('oc_signups').select('*').eq('department_id', cfg.id).eq('shift_date', date).order('start_at').order('level'));
  const names = await namesFor(rows.map((r) => r.user_id));
  const now = Date.now();
  return json(200, {
    date,
    dateLabel: formatDateLong(date),
    isToday: date === todayInTz(new Date(), cfg.tz),
    calls: rows.map((r) => ({
      ...describeCall(r, cfg),
      name: names[r.user_id] || 'Nurse',
      stayStatus: r.stay_status,
      stayNote: r.stay_note,
      stayNotifiedAt: r.stay_notified_at,
      ended: Date.parse(r.end_at) <= now,
    })),
  });
}

async function stay(req) {
  const body = await readJson(req);
  const signupId = needUuid(body.signupId, 'call');
  if (!['stay', 'released'].includes(body.status)) throw new HttpError(400, 'Invalid request.');
  const row = must(await db().from('oc_signups').select('*').eq('id', signupId).maybeSingle());
  if (!row) throw new HttpError(404, 'Call not found.');
  const { cfg } = await managerCtx(req, row.department_id);
  const now = new Date();
  if (Date.parse(row.end_at) <= now.getTime()) throw new HttpError(400, 'This call has already ended.');
  const note = cleanText(body.note, 300);
  const patch = { stay_status: body.status, stay_note: note, stay_notified_at: now.toISOString() };
  if (body.status === 'released') {
    patch.day_reminder_sent_at = row.day_reminder_sent_at || now.toISOString();
    patch.hour_reminder_sent_at = row.hour_reminder_sent_at || now.toISOString();
  } else if (row.stay_status === 'released' && Date.parse(row.start_at) - now.getTime() > cfg.dept.hour_reminder_minutes * 60000) {
    patch.hour_reminder_sent_at = null;
  }
  must(await db().from('oc_signups').update(patch).eq('id', row.id));
  const p = await personFor(row.user_id);
  const sent = await notify(p.contact, buildMessage(body.status, p.name, describeCall(row, cfg), { note, isToday: row.shift_date === todayInTz(now, cfg.tz) }));
  return json(200, { status: body.status, sent });
}

// ---------- periods ----------

async function periods(req) {
  const { cfg } = await managerCtx(req);
  const all = await loadPeriods(cfg.id);
  const today = todayInTz(new Date(), cfg.tz);
  const counts = {};
  if (all.length) {
    const rows = must(await db().from('oc_signups').select('shift_date').eq('department_id', cfg.id).gte('shift_date', all[0].start_date));
    for (const r of rows) {
      const p = periodFor(all, r.shift_date);
      if (p) counts[p.id] = (counts[p.id] || 0) + 1;
    }
  }
  const d = cfg.dept;
  return json(200, {
    usePeriods: d.use_periods,
    periods: all.filter((p) => p.end_date >= addDays(today, -90)).reverse()
      .map((p) => ({ ...describePeriod(p, cfg), signups: counts[p.id] || 0, past: p.end_date < today })),
    suggestion: d.use_periods ? suggestNext(cfg, all, today) : null,
    rules: {
      groups: d.groups, periodWeeks: d.period_weeks, groupGapDays: d.group_gap_days,
      signupOpenTime: hhmm(d.signup_open_time), signupCloseDays: d.signup_close_days, timezone: cfg.tz,
    },
  });
}

async function createPeriod(req) {
  const { a, cfg } = await managerCtx(req);
  const body = await readJson(req);
  const input = {
    startDate: body.startDate,
    signupStart: body.signupStart,
    groupOrder: Array.isArray(body.groupOrder) ? body.groupOrder.map(String) : [],
  };
  if (!isValidDateStr(input.startDate) || !isValidDateStr(input.signupStart)) throw new HttpError(400, 'Please enter valid dates.');
  const errors = validateNewPeriod(cfg, input, await loadPeriods(cfg.id), todayInTz(new Date(), cfg.tz));
  if (errors.length) throw new HttpError(400, errors.join(' '));
  const res = await db().from('oc_periods').insert({ ...buildPeriod(cfg, input), created_by: a.user.id }).select('*').single();
  if (res.error) {
    if (res.error.code === '23505') throw new HttpError(409, 'A period already starts on that date.');
    throw res.error;
  }
  return json(200, { period: describePeriod(res.data, cfg) });
}

async function deletePeriod(req) {
  const id = needUuid((await readJson(req)).id, 'period');
  const p = must(await db().from('oc_periods').select('*').eq('id', id).maybeSingle());
  if (!p) throw new HttpError(404, 'Period not found.');
  const { cfg } = await managerCtx(req, p.department_id);
  const { count, error } = await db().from('oc_signups').select('id', { count: 'exact', head: true })
    .eq('department_id', cfg.id).gte('shift_date', p.start_date).lte('shift_date', p.end_date);
  if (error) throw error;
  if (count) throw new HttpError(409, `This period already has ${count} sign-up${count === 1 ? '' : 's'} and can't be deleted.`);
  must(await db().from('oc_periods').delete().eq('id', id));
  return json(200, { deleted: true });
}

// ---------- hours report ----------

async function hours(req) {
  const { cfg } = await managerCtx(req);
  const sp = new URL(req.url).searchParams;
  const today = todayInTz(new Date(), cfg.tz);
  const all = await loadPeriods(cfg.id);
  let from, to, period = null;
  if (cfg.dept.use_periods && all.length) {
    period = all.find((p) => p.id === sp.get('period')) || periodFor(all, today) || all.find((p) => p.start_date > today) || all[all.length - 1];
    from = period.start_date;
    to = period.end_date;
  } else {
    from = isValidDateStr(sp.get('from')) ? sp.get('from') : today.slice(0, 8) + '01';
    to = isValidDateStr(sp.get('to')) ? sp.get('to') : addDays(addDays(from.slice(0, 8) + '28', 4).slice(0, 8) + '01', -1);
    if (to < from) to = from;
    if (addDays(from, 400) < to) throw new HttpError(400, 'Choose a range of a year or less.');
  }

  const [memberRows, profiles, signups] = await Promise.all([
    db().from('oc_members').select('*').eq('department_id', cfg.id).order('full_name'),
    db().from('oc_profiles').select('id, full_name, email, phone'),
    db().from('oc_signups').select('user_id, block_id, shift_date, level, hours').eq('department_id', cfg.id).gte('shift_date', from).lte('shift_date', to),
  ]);
  const rows = must(signups);
  const perUser = {};
  for (const s of rows) {
    const u = (perUser[s.user_id] ||= { hours: 0, calls: 0 });
    u.hours += Number(s.hours);
    u.calls += 1;
  }
  const minHours = period ? Number(cfg.dept.min_hours) : null;
  const used = new Set();
  const shiftName = (id) => cfg.shifts.find((s) => s.id === id)?.name || null;
  const staff = must(memberRows).map((m) => {
    const ids = must(profiles).filter((p) => matchesContact(m, p)).map((p) => p.id);
    ids.forEach((id) => used.add(id));
    const t = ids.reduce((acc, id) => ({ hours: acc.hours + (perUser[id]?.hours || 0), calls: acc.calls + (perUser[id]?.calls || 0) }), { hours: 0, calls: 0 });
    t.hours = Math.round(t.hours * 100) / 100;
    // People who take call: anyone with a shift (or, without shifts, non-managers), or anyone with calls.
    const takesCall = (usesShifts(cfg) ? Boolean(m.shift_id) : !m.is_manager) || t.calls > 0;
    return { takesCall, name: m.full_name, group: m.group_name, shiftName: shiftName(m.shift_id), signedIn: ids.length > 0, ...t, met: minHours === null ? null : t.hours >= minHours };
  }).filter((x) => x.takesCall).map(({ takesCall, ...x }) => x)
    .sort((x, y) => x.hours - y.hours || x.name.localeCompare(y.name));
  const otherIds = Object.keys(perUser).filter((id) => !used.has(id));
  const otherNames = await namesFor(otherIds);
  const others = otherIds.map((id) => ({ name: otherNames[id] || 'Nurse', ...perUser[id] }));

  return json(200, {
    usePeriods: cfg.dept.use_periods,
    period: period ? describePeriod(period, cfg) : null,
    periods: [...all].reverse().map((p) => ({ id: p.id, label: periodLabel(p) })),
    from, to, label: period ? periodLabel(period) : `${formatDateLong(from)} – ${formatDateLong(to)}`,
    minHours,
    slots: {
      total: slotCount(cfg, from, to),
      filled: rows.length,
      openAfterClose: period && phaseOf(period) === 'vacancy' ? openSlotsAfterClose(cfg, period, rows).total : null,
    },
    staff,
    others,
  });
}

// ---------- staff list ----------

async function staffList(req) {
  const { a, cfg } = await managerCtx(req);
  const [rows, profiles] = await Promise.all([
    db().from('oc_members').select('*').eq('department_id', cfg.id).order('full_name'),
    db().from('oc_profiles').select('email, phone'),
  ]);
  const shiftName = (id) => cfg.shifts.find((s) => s.id === id)?.name || null;
  return json(200, {
    groups: cfg.dept.groups,
    shifts: activeShifts(cfg).map((s) => ({ id: s.id, name: s.name })),
    staff: must(rows).map((r) => ({
      id: r.id, fullName: r.full_name, email: r.email, phone: r.phone,
      group: r.group_name, shiftId: r.shift_id, shiftName: shiftName(r.shift_id), manager: r.is_manager,
      signedIn: must(profiles).some((p) => matchesContact(r, p)),
      isMe: matchesContact(r, a.contact),
    })),
  });
}

async function staffSave(req) {
  const { a, cfg } = await managerCtx(req);
  const b = await readJson(req);
  const row = {
    full_name: cleanText(b.fullName, 100),
    email: normEmail(b.email),
    phone: normPhone(b.phone),
    group_name: b.group || null,
    shift_id: b.shiftId || null,
    is_manager: bool(b.manager),
  };
  if (!row.full_name || row.full_name.length < 2) throw new HttpError(400, 'Please enter the full name.');
  if (!row.email && !row.phone) throw new HttpError(400, 'Add an email or a mobile number so they can sign in.');
  if (row.group_name && !cfg.dept.groups.includes(row.group_name)) throw new HttpError(400, 'Choose one of this department\'s groups.');
  if (row.shift_id && !cfg.shifts.some((s) => s.id === row.shift_id)) throw new HttpError(400, 'Choose one of this department\'s shifts.');

  const id = b.id ? needUuid(b.id, 'staff member') : null;
  if (id) {
    const existing = must(await db().from('oc_members').select('*').eq('id', id).eq('department_id', cfg.id).maybeSingle());
    if (!existing) throw new HttpError(404, 'Staff member not found.');
    const isMe = matchesContact(existing, a.contact);
    const isAdmin = adminOfHospital(a, cfg.hospital.id, cfg.org.id);
    if (isMe && !isAdmin) {
      if (!row.is_manager) throw new HttpError(400, "You can't remove your own manager access. Ask another manager or an admin.");
      if (!matchesContact(row, a.contact)) throw new HttpError(400, "You can't change the email or phone you're signed in with here.");
    }
  }
  const q = id
    ? db().from('oc_members').update(row).eq('id', id).eq('department_id', cfg.id)
    : db().from('oc_members').insert({ ...row, department_id: cfg.id });
  const res = await q.select('id');
  if (res.error) {
    if (res.error.code === '23505') throw new HttpError(409, 'That email or phone number is already on this department\'s staff list.');
    throw res.error;
  }
  return json(200, { id: res.data[0]?.id });
}

async function staffDelete(req) {
  const { a, cfg } = await managerCtx(req);
  const id = needUuid((await readJson(req)).id, 'staff member');
  const row = must(await db().from('oc_members').select('*').eq('id', id).eq('department_id', cfg.id).maybeSingle());
  if (!row) throw new HttpError(404, 'Staff member not found.');
  if (matchesContact(row, a.contact) && !adminOfHospital(a, cfg.hospital.id, cfg.org.id)) {
    throw new HttpError(400, "You can't remove yourself. Ask another manager or an admin.");
  }
  must(await db().from('oc_members').delete().eq('id', id));
  return json(200, { deleted: true });
}

// Paste a list: one person per line — Name, email or phone, group, shift
async function staffImport(req) {
  const { cfg } = await managerCtx(req);
  const { text } = await readJson(req);
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 500);
  if (!lines.length) throw new HttpError(400, 'Paste at least one line.');
  const shiftByName = Object.fromEntries(cfg.shifts.map((s) => [s.name.toLowerCase(), s.id]));
  const added = [];
  const problems = [];
  for (const [i, line] of lines.entries()) {
    const parts = line.split(/[,\t]/).map((p) => p.trim());
    try {
      const [name, ...rest] = parts;
      const row = { department_id: cfg.id, full_name: cleanText(name, 100), email: null, phone: null, group_name: null, shift_id: null, is_manager: false };
      if (!row.full_name || row.full_name.length < 2) throw new HttpError(400, 'missing name');
      for (const p of rest.filter(Boolean)) {
        if (p.includes('@')) row.email = normEmail(p);
        else if (/^\+?[\d\s().-]{10,}$/.test(p)) row.phone = normPhone(p);
        else if (cfg.dept.groups.includes(p) || cfg.dept.groups.includes(p.replace(/^group\s+/i, ''))) row.group_name = p.replace(/^group\s+/i, '');
        else if (shiftByName[p.toLowerCase()]) row.shift_id = shiftByName[p.toLowerCase()];
        else throw new HttpError(400, `didn't recognise "${p}"`);
      }
      if (!row.email && !row.phone) throw new HttpError(400, 'needs an email or mobile number');
      const res = await db().from('oc_members').insert(row).select('id');
      if (res.error) throw res.error.code === '23505' ? new HttpError(409, 'email or phone already on the list') : res.error;
      added.push(row.full_name);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      problems.push(`Line ${i + 1} (${parts[0] || ''}): ${e.message}`);
    }
  }
  return json(200, { added: added.length, problems });
}

// ---------- settings ----------

async function settingsGet(req) {
  const { a, cfg } = await managerCtx(req);
  const counts = must(await db().from('oc_signups').select('block_id').eq('department_id', cfg.id).gte('end_at', new Date().toISOString()));
  const upcoming = {};
  for (const r of counts) upcoming[r.block_id] = (upcoming[r.block_id] || 0) + 1;
  return json(200, { ...describeSettings(cfg), upcomingByBlock: upcoming, canEditHospital: adminOfHospital(a, cfg.hospital.id, cfg.org.id) });
}

async function settingsSave(req) {
  const { cfg } = await managerCtx(req);
  const b = await readJson(req);
  const name = cleanText(b.name, 120);
  if (!name || name.length < 2) throw new HttpError(400, 'Please enter the department name.');
  const groups = Array.isArray(b.groups) ? b.groups.map((g) => cleanText(g, 12)).filter(Boolean) : [];
  if (new Set(groups).size !== groups.length) throw new HttpError(400, 'Group names must be different from each other.');
  if (groups.length > 6) throw new HttpError(400, 'Up to 6 groups.');
  if (!isValidTime(b.signupOpenTime)) throw new HttpError(400, 'Choose the time sign-up opens.');
  const minHours = Number(b.minHours);
  if (!Number.isFinite(minHours) || minHours < 0 || minHours > 2000) throw new HttpError(400, 'Minimum hours must be from 0 to 2000.');

  const patch = {
    name,
    use_periods: bool(b.usePeriods),
    period_weeks: int(b.periodWeeks, 1, 26, 'Period length (weeks)'),
    min_hours: Math.round(minHours * 10) / 10,
    groups,
    group_gap_days: int(b.groupGapDays, 0, 14, 'Days between groups'),
    signup_open_time: hhmm(b.signupOpenTime),
    signup_close_days: int(b.signupCloseDays, 0, 30, 'Days sign-up stays open'),
    book_weeks_ahead: int(b.bookWeeksAhead, 1, 52, 'Weeks ahead'),
    vacancy_open_days: int(b.vacancyOpenDays, 0, 60, 'Vacancy days'),
    cancel_cutoff_hours: int(b.cancelCutoffHours, 0, 720, 'Release cutoff (hours)'),
    day_reminder_hour: int(b.dayReminderHour, 0, 23, 'Morning reminder hour'),
    hour_reminder_minutes: int(b.hourReminderMinutes, 0, 1440, 'Reminder before the call (minutes)'),
    switch_needs_approval: bool(b.switchNeedsApproval),
    updated_at: new Date().toISOString(),
  };
  must(await db().from('oc_departments').update(patch).eq('id', cfg.id));

  // Staff in a group that no longer exists lose that group.
  let cleared = 0;
  const removed = cfg.dept.groups.filter((g) => !groups.includes(g));
  if (removed.length) {
    const r = must(await db().from('oc_members').update({ group_name: null }).eq('department_id', cfg.id).in('group_name', removed).select('id'));
    cleared = r.length;
  }
  return json(200, { saved: true, groupsCleared: cleared, note: 'Changes apply to new periods and new sign-ups. Periods already opened keep their dates and group order.' });
}

async function blockSave(req) {
  const { cfg } = await managerCtx(req);
  const b = await readJson(req);
  const label = cleanText(b.label, 40);
  if (!label) throw new HttpError(400, 'Give the call time a name, e.g. "Evening" or "3–7 PM".');
  if (!isValidTime(b.startTime) || !isValidTime(b.endTime)) throw new HttpError(400, 'Choose a start and end time.');
  const days = Array.isArray(b.days) ? [...new Set(b.days.map(Number))].filter((d) => d >= 1 && d <= 7).sort() : [];
  if (!days.length) throw new HttpError(400, 'Choose at least one day of the week.');
  const levels = int(b.levels, 1, 3, 'Number of calls');
  const row = {
    label, start_time: hhmm(b.startTime), end_time: hhmm(b.endTime), days, levels,
    sort: Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0,
    active: b.active === undefined ? true : bool(b.active),
  };
  const hours = nominalHours(row);

  if (b.id) {
    const id = needUuid(b.id, 'call time');
    const existing = cfg.blocks.find((x) => x.id === id);
    if (!existing) throw new HttpError(404, 'Call time not found.');
    if (levels < existing.levels) {
      const { count, error } = await db().from('oc_signups').select('id', { count: 'exact', head: true })
        .eq('block_id', id).gt('level', levels).gte('end_at', new Date().toISOString());
      if (error) throw error;
      if (count) throw new HttpError(409, `${count} upcoming sign-up(s) use the call level you're removing. Ask those nurses to release or switch first.`);
    }
    must(await db().from('oc_blocks').update(row).eq('id', id).eq('department_id', cfg.id));
    const { count } = await db().from('oc_signups').select('id', { count: 'exact', head: true }).eq('block_id', id).gte('start_at', new Date().toISOString());
    const changedTimes = existing.start_time !== row.start_time || existing.end_time !== row.end_time;
    return json(200, { id, hours, note: changedTimes && count ? `${count} upcoming sign-up(s) keep their original times. New sign-ups use ${timeRangeLabel(row.start_time, row.end_time)}.` : null });
  }
  const created = must(await db().from('oc_blocks').insert({ ...row, department_id: cfg.id }).select('id').single());
  // New call times start open to every current shift; adjust on "Who can take each call".
  const shifts = activeShifts(cfg);
  if (shifts.length) must(await db().from('oc_block_rules').insert(shifts.map((s) => ({ block_id: created.id, shift_id: s.id, access: 'signup' }))));
  return json(200, { id: created.id, hours, note: shifts.length ? 'All shifts can take this call for now. Change it under "Who can take each call".' : null });
}

async function blockDelete(req) {
  const { cfg } = await managerCtx(req);
  const id = needUuid((await readJson(req)).id, 'call time');
  if (!cfg.blocks.some((x) => x.id === id)) throw new HttpError(404, 'Call time not found.');
  const { count: future, error: e1 } = await db().from('oc_signups').select('id', { count: 'exact', head: true }).eq('block_id', id).gte('end_at', new Date().toISOString());
  if (e1) throw e1;
  if (future) throw new HttpError(409, `${future} upcoming sign-up(s) use this call time. Turn it off instead, or ask the nurses to release their calls first.`);
  const { count: any, error: e2 } = await db().from('oc_signups').select('id', { count: 'exact', head: true }).eq('block_id', id);
  if (e2) throw e2;
  if (any) {
    must(await db().from('oc_blocks').update({ active: false }).eq('id', id));
    return json(200, { deleted: false, deactivated: true, note: 'This call time has past sign-ups, so it was turned off instead of deleted (history is kept).' });
  }
  must(await db().from('oc_blocks').delete().eq('id', id));
  return json(200, { deleted: true });
}

async function shiftSave(req) {
  const { cfg } = await managerCtx(req);
  const b = await readJson(req);
  const name = cleanText(b.name, 40);
  if (!name) throw new HttpError(400, 'Give the shift a name, e.g. "7a–3p".');
  const dup = cfg.shifts.find((s) => s.name.toLowerCase() === name.toLowerCase() && s.id !== b.id);
  if (dup) throw new HttpError(409, 'There is already a shift with that name.');
  const row = { name, sort: Number.isInteger(Number(b.sort)) ? Number(b.sort) : 0 };
  if (b.id) {
    const id = needUuid(b.id, 'shift');
    if (!cfg.shifts.some((s) => s.id === id)) throw new HttpError(404, 'Shift not found.');
    must(await db().from('oc_shifts').update(row).eq('id', id));
    return json(200, { id });
  }
  const created = must(await db().from('oc_shifts').insert({ ...row, department_id: cfg.id }).select('id').single());
  return json(200, { id: created.id, note: 'Now choose which calls this shift can take under "Who can take each call", and set it for staff on the Staff tab.' });
}

async function shiftDelete(req) {
  const { cfg } = await managerCtx(req);
  const id = needUuid((await readJson(req)).id, 'shift');
  if (!cfg.shifts.some((s) => s.id === id)) throw new HttpError(404, 'Shift not found.');
  const affected = must(await db().from('oc_members').select('id').eq('shift_id', id));
  must(await db().from('oc_shifts').delete().eq('id', id));
  return json(200, { deleted: true, staffCleared: affected.length });
}

// { rules: { blockId: { shiftId: 'signup' | 'after_close' | null } } } — replaces all rules for the department.
async function rulesSave(req) {
  const { cfg } = await managerCtx(req);
  const { rules } = await readJson(req);
  if (!rules || typeof rules !== 'object') throw new HttpError(400, 'Invalid request.');
  const blockIds = new Set(cfg.blocks.map((b) => b.id));
  const shiftIds = new Set(cfg.shifts.map((s) => s.id));
  const rows = [];
  for (const [blockId, byShift] of Object.entries(rules)) {
    if (!blockIds.has(blockId) || !byShift || typeof byShift !== 'object') throw new HttpError(400, 'Unknown call time in rules.');
    for (const [shiftId, access] of Object.entries(byShift)) {
      if (!shiftIds.has(shiftId)) throw new HttpError(400, 'Unknown shift in rules.');
      if (access === null || access === '' || access === 'none') continue;
      if (!['signup', 'after_close'].includes(access)) throw new HttpError(400, 'Invalid rule.');
      rows.push({ block_id: blockId, shift_id: shiftId, access });
    }
  }
  if (cfg.blocks.length) must(await db().from('oc_block_rules').delete().in('block_id', [...blockIds]));
  if (rows.length) must(await db().from('oc_block_rules').insert(rows));
  return json(200, { saved: rows.length });
}

export const MANAGE_ROUTES = {
  'GET /api/oncall/manage/today': today,
  'POST /api/oncall/manage/stay': stay,
  'GET /api/oncall/manage/periods': periods,
  'POST /api/oncall/manage/periods': createPeriod,
  'POST /api/oncall/manage/periods/delete': deletePeriod,
  'GET /api/oncall/manage/hours': hours,
  'GET /api/oncall/manage/staff': staffList,
  'POST /api/oncall/manage/staff': staffSave,
  'POST /api/oncall/manage/staff/delete': staffDelete,
  'POST /api/oncall/manage/staff/import': staffImport,
  'GET /api/oncall/manage/settings': settingsGet,
  'POST /api/oncall/manage/settings': settingsSave,
  'POST /api/oncall/manage/blocks': blockSave,
  'POST /api/oncall/manage/blocks/delete': blockDelete,
  'POST /api/oncall/manage/shifts': shiftSave,
  'POST /api/oncall/manage/shifts/delete': shiftDelete,
  'POST /api/oncall/manage/rules': rulesSave,
};

