// Manager screens: Today, Periods, Hours, Staff, Settings.
import {
  $, $$, el, state, api, post, attempt, toast, confirmBox, dq, btn, emptyNote, table, formDialog, printWith, printedAt, sentBy, setBusy,
} from './core.js';

const SUBS = ['today', 'periods', 'hours', 'staff', 'settings'];

export function switchSub(sub) {
  state.sub = SUBS.includes(sub) ? sub : 'today';
  $$('.sub-tabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.sub === state.sub));
  for (const k of SUBS) $('#sub-' + k).hidden = k !== state.sub;
  ({ today: loadToday, periods: loadPeriods, hours: () => loadHours(), staff: loadStaff, settings: loadSettings })[state.sub]();
}

const fmtDate = (s, opts = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(s + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });
const addDays = (s, n) => {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const clock = (t) => {
  const [h, m] = t.split(':').map(Number);
  return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''} ${h < 12 ? 'AM' : 'PM'}`;
};

// ---------- today ----------

export async function loadToday() {
  const date = $('#today-date').value;
  const data = await attempt(() => api(`manage/today?${dq(date ? `&date=${date}` : '')}`));
  if (!data) return;
  if (!date) $('#today-date').value = data.date;
  const list = $('#today-list');
  if (!data.calls.length) return list.replaceChildren(emptyNote(`No one is on call ${data.isToday ? 'today' : 'on ' + data.dateLabel}.`));
  list.replaceChildren(...data.calls.map((c) => {
    const card = el('div', 'sw-card');
    const top = el('div', 'sw-top');
    top.append(el('div', 'sw-call', `${c.name} · ${c.roleLabel} · ${c.blockLabel} · ${c.timeLabel}`));
    top.append(c.stayStatus
      ? el('span', 'pill ' + (c.stayStatus === 'stay' ? 'pending_manager' : 'approved'), c.stayStatus === 'stay' ? 'Told to stay' : 'Released')
      : el('span', 'pill', 'Not told yet'));
    card.append(top);
    if (c.stayNote) card.append(el('div', 'muted small', `Note: "${c.stayNote}"`));
    if (c.stayNotifiedAt) card.append(el('div', 'muted small', 'Sent ' + new Date(c.stayNotifiedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })));
    if (!c.ended) {
      const row = el('div', 'sw-actions');
      row.append(btn('Needs to stay', 'primary', () => notifyStay(c, 'stay')), btn('Released', 'ghost', () => notifyStay(c, 'released')));
      card.append(row);
    }
    return card;
  }));
}

async function notifyStay(c, status) {
  const r = await formDialog({
    title: status === 'stay' ? 'Ask nurse to stay' : 'Release nurse from call',
    intro: `${c.name} · ${c.roleLabel} · ${c.blockLabel} · ${c.timeLabel}. ${status === 'stay' ? 'They get an email and text asking them to stay.' : "They get an email and text saying they don't need to stay."}`,
    fields: [{ name: 'note', label: 'Note (optional)', type: 'textarea', rows: 2, maxLength: 300, placeholder: 'e.g. Room 5 running late' }],
    submitLabel: status === 'stay' ? 'Send "please stay"' : 'Send "released"',
    onSubmit: (v) => post('manage/stay', { signupId: c.id, status, note: v.note }),
  });
  if (r) toast(`${c.name} notified.${sentBy(r.sent)}`);
  loadToday();
}

// ---------- periods ----------

let periodRules = null;

export async function loadPeriods() {
  const data = await attempt(() => api(`manage/periods?${dq()}`));
  if (!data) return;
  periodRules = data.rules;
  $('#period-form').hidden = !data.usePeriods;
  $('#no-periods-note').hidden = data.usePeriods;
  if (data.usePeriods) {
    const g = data.rules.groups;
    $('#p-order-wrap').hidden = !g.length;
    if (!$('#p-start').value && data.suggestion) {
      $('#p-start').value = data.suggestion.startDate;
      $('#p-signup').value = data.suggestion.signupStart;
      $('#p-order').value = data.suggestion.groupOrder.join(', ');
    }
    $('#p-order-hint').textContent = g.length ? `Groups: ${g.join(', ')}. List them in the order they sign up.` : '';
    periodPreview();
  }
  const list = $('#period-list');
  if (!data.periods.length) return list.replaceChildren(emptyNote(data.usePeriods ? 'No periods yet. Open the first one above.' : ''));
  list.replaceChildren(...data.periods.map((p) => {
    const card = el('div', 'sw-card');
    const top = el('div', 'sw-top');
    top.append(el('div', 'sw-call', p.label));
    top.append(el('span', 'pill ' + (p.past ? '' : p.phase === 'vacancy' ? 'approved' : 'pending_manager'), p.past ? 'Ended' : p.phaseLabel));
    card.append(top);
    card.append(el('div', 'small', p.opens.map((o) => (o.group ? `Group ${o.group}: ${o.label}` : `Opens ${o.label}`)).join(' · ') + ` · Closes ${p.closesLabel}`));
    card.append(el('div', 'muted small', `${p.signups} sign-up${p.signups === 1 ? '' : 's'}`));
    if (!p.signups && !p.past) {
      const row = el('div', 'sw-actions');
      row.append(btn('Delete', 'ghost', async () => {
        if (!(await confirmBox('Delete this period?', p.label, 'Delete', true))) return;
        if (await attempt(() => post('manage/periods/delete', { id: p.id }))) toast('Period deleted.');
        $('#p-start').value = '';
        loadPeriods();
      }));
      card.append(row);
    }
    return card;
  }));
}

const readOrder = () => $('#p-order').value.split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);

export function periodPreview() {
  const r = periodRules;
  const start = $('#p-start').value;
  const signup = $('#p-signup').value;
  if (!r || !start || !signup) return ($('#p-preview').textContent = '');
  const order = r.groups.length ? readOrder() : [];
  const n = Math.max(1, order.length);
  const opens = [];
  for (let k = 0; k < n; k++) opens.push(`${order[k] ? 'Group ' + order[k] : 'Everyone'} signs up ${fmtDate(addDays(signup, k * r.groupGapDays))} at ${clock(r.signupOpenTime)}`);
  const closeDay = addDays(signup, (n - 1) * r.groupGapDays + r.signupCloseDays);
  $('#p-preview').textContent = `Calls ${fmtDate(start)} – ${fmtDate(addDays(start, r.periodWeeks * 7 - 1))}. ${opens.join('; ')}; sign-up closes ${fmtDate(closeDay)} at 11:59 PM.`;
}

export async function onPeriodSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const body = { startDate: $('#p-start').value, signupStart: $('#p-signup').value, groupOrder: periodRules?.groups.length ? readOrder() : [] };
  if (!body.startDate || !body.signupStart) return toast('Please choose both dates.', 'error');
  setBusy(form, true);
  const r = await attempt(() => post(`manage/periods?${dq()}`, body));
  setBusy(form, false);
  if (r) {
    toast(`Period ${r.period.label} opened. Staff are notified automatically when their sign-up opens.`);
    $('#p-start').value = '';
  }
  loadPeriods();
}

// ---------- hours ----------

export async function loadHours(arg) {
  let qs = '';
  if (arg?.period) qs = `&period=${encodeURIComponent(arg.period)}`;
  if (arg?.from) qs = `&from=${arg.from}&to=${arg.to}`;
  const data = await attempt(() => api(`manage/hours?${dq(qs)}`));
  if (!data) return;
  state.hoursLabel = data.label;
  const sel = $('#hours-period');
  sel.hidden = !data.period;
  $('#hours-range').hidden = Boolean(data.period);
  if (data.period) {
    sel.replaceChildren(...data.periods.map((p) => {
      const o = el('option', '', p.label);
      o.value = p.id;
      return o;
    }));
    sel.value = data.period.id;
  } else {
    $('#hours-from').value = data.from;
    $('#hours-to').value = data.to;
  }
  const under = data.minHours !== null ? data.staff.filter((s) => !s.met).length : null;
  $('#hours-summary').textContent =
    `${data.period ? data.period.phaseLabel + '. ' : ''}${data.slots.filled} of ${data.slots.total} call slots filled` +
    (data.slots.openAfterClose ? ` · ${data.slots.openAfterClose} still open` : '') +
    (under !== null ? ` · ${under} staff under ${data.minHours} hours.` : '.');
  const rows = [...data.staff, ...data.others.map((o) => ({ ...o, group: '', shiftName: 'Not on staff list', signedIn: true, met: data.minHours !== null ? o.hours >= data.minHours : null }))];
  if (!rows.length) return $('#hours-table').replaceChildren(emptyNote('No staff who take call yet.'));
  const headers = ['Name', 'Group', 'Shift', 'Calls', 'Hours'];
  if (data.minHours !== null) headers.push(`Min ${data.minHours}`);
  $('#hours-table').replaceChildren(table(headers, rows.map((s) => {
    const name = [el('div', '', s.name)];
    if (!s.signedIn) name.push(el('div', 'muted small', 'Has not signed in yet'));
    const r = [name, s.group || '—', s.shiftName || '—', String(s.calls), String(s.hours)];
    if (data.minHours !== null) r.push(el('span', s.met ? 'ok-text' : 'warn-text', s.met ? '✓ Met' : `${Math.round((data.minHours - s.hours) * 10) / 10} short`));
    return r;
  })));
}

export function printHours() {
  printWith('print-hours', `Call hours · ${state.hoursLabel || ''} · Printed ${printedAt()}`);
}

// ---------- staff ----------

let staffData = null;

export async function loadStaff() {
  staffData = await attempt(() => api(`manage/staff?${dq()}`));
  if (!staffData) return;
  const { staff, groups, shifts } = staffData;
  $('#staff-hint').textContent =
    'Only people on this list can sign in to this department.' +
    (groups.length ? ' Group decides who signs up first.' : '') +
    (shifts.length ? ' Shift decides which calls they can take.' : '');
  if (!staff.length) return $('#staff-table').replaceChildren(emptyNote('No staff yet. Add people one at a time or paste a list.'));
  const headers = ['Name'];
  if (groups.length) headers.push('Group');
  if (shifts.length) headers.push('Shift');
  headers.push('Contact', { label: '', cls: 'actions' });
  $('#staff-table').replaceChildren(table(headers, staff.map((r) => {
    const name = [el('span', '', r.fullName)];
    if (r.manager) name.push(el('span', 'pill pending_manager', 'Manager'));
    if (r.isMe) name.push(el('span', 'muted small', ' (you)'));
    const contact = [el('div', '', r.email || 'No email'), el('div', 'muted', r.phone || 'No phone')];
    if (!r.signedIn) contact.push(el('div', 'muted small', 'Not signed in yet'));
    const row = [name];
    if (groups.length) row.push(r.group || '—');
    if (shifts.length) row.push(r.shiftName ? r.shiftName : el('span', 'warn-text', 'Not set'));
    row.push(contact, [btn('Edit', 'ghost', () => editStaff(r))]);
    return row;
  })));
}

export async function editStaff(r = null) {
  const { groups, shifts } = staffData;
  const fields = [
    { name: 'fullName', label: 'Full name', value: r?.fullName || '', maxLength: 100 },
    { name: 'email', label: 'Email', type: 'email', value: r?.email || '', autocomplete: 'off' },
    { name: 'phone', label: 'Mobile number', type: 'tel', value: r?.phone || '', placeholder: '(732) 555-1234', hint: 'Add an email or a mobile number (or both). They sign in with either.' },
  ];
  if (groups.length) fields.push({ name: 'group', label: 'Group', type: 'select', value: r?.group || '', options: [{ value: '', label: '— (signs up with the last group)' }, ...groups.map((g) => ({ value: g, label: `Group ${g}` }))], half: true });
  if (shifts.length) fields.push({ name: 'shiftId', label: 'Shift', type: 'select', value: r?.shiftId || '', options: [{ value: '', label: '— (no call)' }, ...shifts.map((s) => ({ value: s.id, label: s.name }))], half: true });
  fields.push({ name: 'manager', label: 'Nurse manager for this department (opens periods, approves switches, changes settings)', type: 'checkbox', value: r?.manager });
  const res = await formDialog({
    title: r ? 'Edit staff member' : 'Add staff member',
    fields,
    extra: r && !r.isMe ? {
      label: 'Remove',
      onClick: async () => {
        if (!(await confirmBox('Remove from staff list?', `${r.fullName}\n\nThey can no longer sign up here. Calls they already have stay on the schedule.`, 'Remove', true))) return false;
        return post(`manage/staff/delete?${dq()}`, { id: r.id });
      },
    } : null,
    onSubmit: (v) => post(`manage/staff?${dq()}`, { ...v, id: r?.id }),
  });
  if (res) toast(res.extra ? 'Removed.' : 'Saved.');
  loadStaff();
}

export async function importStaff() {
  const { groups, shifts } = staffData;
  const example = ['Jane Doe, jane.doe@example.com', groups[0] && groups[0], shifts[0]?.name].filter(Boolean).join(', ');
  const res = await formDialog({
    title: 'Paste a staff list',
    intro: `One person per line: name, then email and/or mobile${groups.length ? ', group' : ''}${shifts.length ? ', shift' : ''}. Separate with commas or tabs (you can paste from a spreadsheet).`,
    fields: [
      { name: 'text', label: 'Staff list', type: 'textarea', rows: 10, placeholder: example },
      ...(groups.length ? [{ name: 'g', type: 'note', label: `Groups here: ${groups.join(', ')}` }] : []),
      ...(shifts.length ? [{ name: 's', type: 'note', label: `Shifts here: ${shifts.map((s) => s.name).join(', ')}` }] : []),
    ],
    submitLabel: 'Add to staff list',
    wide: true,
    onSubmit: (v) => post(`manage/staff/import?${dq()}`, { text: v.text }),
  });
  if (res) {
    toast(`Added ${res.added}.${res.problems.length ? ` ${res.problems.length} line(s) skipped — see below.` : ''}`, res.problems.length ? 'info' : 'ok');
    $('#staff-import-problems').replaceChildren(...res.problems.map((p) => el('div', 'warn-text small', p)));
  }
  loadStaff();
}

// ---------- settings ----------

let settings = null;

export async function loadSettings() {
  settings = await attempt(() => api(`manage/settings?${dq()}`));
  if (!settings) return;
  renderGeneral();
  renderBlocks();
  renderShifts();
  renderRules();
}

const HOURS = Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${h % 12 || 12}:00 ${h < 12 ? 'AM' : 'PM'}` }));

function fieldRow(label, input, hint) {
  const w = el('div', 'field');
  const l = el('label', '', label);
  l.htmlFor = input.id;
  w.append(l, input);
  if (hint) w.append(el('div', 'muted small hint', hint));
  return w;
}
function numInput(id, value, min, max, step = 1) {
  const i = el('input');
  i.type = 'number';
  i.id = id;
  i.value = value;
  i.min = min;
  i.max = max;
  i.step = step;
  i.inputMode = 'numeric';
  return i;
}
function selectInput(id, value, options) {
  const s = el('select');
  s.id = id;
  for (const o of options) {
    const opt = el('option', '', o.label);
    opt.value = o.value;
    s.append(opt);
  }
  s.value = String(value);
  return s;
}

function renderGeneral() {
  const s = settings;
  const box = $('#settings-general');
  box.replaceChildren();
  const form = el('form', 'stack');
  form.noValidate = true;

  const name = el('input');
  name.id = 'st-name';
  name.value = s.name;
  name.maxLength = 120;
  form.append(fieldRow('Department name', name));
  form.append(el('p', 'muted small', `${s.hospital.name} · ${s.hospital.state} · ${s.hospital.timezoneLabel} time${s.canEditHospital ? ' (change on the Admin tab)' : ''}`));

  // Sign-up style
  form.append(el('h4', '', 'How staff sign up'));
  const style = el('div', 'choice-list');
  for (const [val, label, hint] of [
    ['periods', 'In periods with a sign-up window', 'e.g. 6-week periods; groups take turns signing up first; minimum hours per period.'],
    ['anytime', 'Any time', 'Staff sign up for any open call up to a few weeks ahead.'],
  ]) {
    const lab = el('label', 'choice');
    const r = el('input');
    r.type = 'radio';
    r.name = 'st-style';
    r.value = val;
    r.checked = (val === 'periods') === s.usePeriods;
    const t = el('div');
    t.append(el('strong', '', label), el('div', 'muted small', hint));
    lab.append(r, t);
    style.append(lab);
  }
  form.append(style);

  const periodBox = el('div', 'grid-3');
  periodBox.id = 'st-period-box';
  const groups = el('input');
  groups.id = 'st-groups';
  groups.value = s.groups.join(', ');
  groups.placeholder = 'e.g. A, B';
  const openTime = el('input');
  openTime.type = 'time';
  openTime.id = 'st-open-time';
  openTime.value = s.signupOpenTime;
  periodBox.append(
    fieldRow('Period length (weeks)', numInput('st-weeks', s.periodWeeks, 1, 26)),
    fieldRow('Minimum call hours per period', numInput('st-min', s.minHours, 0, 2000, 0.5), '0 = no minimum'),
    fieldRow('Groups', groups, 'Comma-separated. Leave empty for no groups (everyone signs up at once).'),
    fieldRow('Days between groups opening', numInput('st-gap', s.groupGapDays, 0, 14), 'e.g. 1 = Group A Saturday, Group B Sunday'),
    fieldRow('Sign-up opens at', openTime),
    fieldRow('After the last group opens, sign-up…', selectInput('st-close', s.signupCloseDays, Array.from({ length: 15 }, (_, n) => ({ value: String(n), label: n === 0 ? 'Closes that night (11:59 PM)' : `${n} more day${n > 1 ? 's' : ''}` })))),
  );
  form.append(periodBox);

  const anyBox = el('div', 'grid-3');
  anyBox.id = 'st-any-box';
  anyBox.append(
    fieldRow('Staff can sign up up to (weeks ahead)', numInput('st-ahead', s.bookWeeksAhead, 1, 52)),
    fieldRow('"Vacancies only" shifts can take open calls (days before)', numInput('st-vacancy', s.vacancyOpenDays, 0, 60)),
  );
  form.append(anyBox);

  form.append(el('h4', '', 'Changes and reminders'));
  const g2 = el('div', 'grid-3');
  g2.append(
    fieldRow('Staff can release a call until (hours before it starts)', numInput('st-cutoff', s.cancelCutoffHours, 0, 720)),
    fieldRow('Morning-of reminder at', selectInput('st-day-rem', s.dayReminderHour, HOURS)),
    fieldRow('Second reminder (minutes before the call)', numInput('st-hour-rem', s.hourReminderMinutes, 0, 1440, 5), '0 = no second reminder'),
  );
  form.append(g2);
  const appr = el('label', 'check');
  const cb = el('input');
  cb.type = 'checkbox';
  cb.id = 'st-approval';
  cb.checked = s.switchNeedsApproval;
  appr.append(cb, document.createTextNode(' Call switches need manager approval (otherwise the colleague accepting completes the switch)'));
  form.append(appr);

  const summary = el('p', 'settings-summary small');
  summary.id = 'st-summary';
  form.append(summary);
  const save = el('button', 'btn primary', 'Save settings');
  save.type = 'submit';
  form.append(save);

  const sync = () => {
    const periods = $('input[name="st-style"]:checked', form).value === 'periods';
    periodBox.hidden = !periods;
    anyBox.hidden = periods;
    summary.textContent = describeGeneral(form);
  };
  form.addEventListener('input', sync);
  form.addEventListener('change', sync);
  form.addEventListener('submit', saveGeneral);
  box.append(form);
  sync();
}

function readGeneral() {
  const v = (id) => $('#' + id).value;
  return {
    ...settings,
    name: v('st-name'),
    usePeriods: $('input[name="st-style"]:checked').value === 'periods',
    periodWeeks: Number(v('st-weeks')),
    minHours: Number(v('st-min')),
    groups: v('st-groups').split(',').map((x) => x.trim()).filter(Boolean),
    groupGapDays: Number(v('st-gap')),
    signupOpenTime: v('st-open-time'),
    signupCloseDays: Number(v('st-close')),
    bookWeeksAhead: Number(v('st-ahead')),
    vacancyOpenDays: Number(v('st-vacancy')),
    cancelCutoffHours: Number(v('st-cutoff')),
    dayReminderHour: Number(v('st-day-rem')),
    hourReminderMinutes: Number(v('st-hour-rem')),
    switchNeedsApproval: $('#st-approval').checked,
  };
}

function describeGeneral() {
  const g = readGeneral();
  const parts = [];
  if (g.usePeriods) {
    parts.push(`${g.periodWeeks}-week periods${g.minHours ? `, at least ${g.minHours} call hours each` : ''}.`);
    if (g.groups.length > 1) parts.push(`Groups ${g.groups.join(', ')} take turns signing up first, ${g.groupGapDays} day(s) apart, from ${g.signupOpenTime ? clock(g.signupOpenTime) : '—'}.`);
    else parts.push(`Everyone signs up at once from ${g.signupOpenTime ? clock(g.signupOpenTime) : '—'}.`);
  } else {
    parts.push(`Staff sign up any time, up to ${g.bookWeeksAhead} weeks ahead.`);
  }
  parts.push(`Release up to ${g.cancelCutoffHours} hours before. Reminders at ${HOURS[g.dayReminderHour]?.label || '—'} on the day${g.hourReminderMinutes ? ` and ${g.hourReminderMinutes} minutes before` : ''}.`);
  parts.push(g.switchNeedsApproval ? 'Switches need manager approval.' : 'Switches complete when the colleague accepts.');
  return parts.join(' ');
}

async function saveGeneral(e) {
  e.preventDefault();
  const form = e.currentTarget;
  setBusy(form, true);
  const r = await attempt(() => post(`manage/settings?${dq()}`, readGeneral()));
  setBusy(form, false);
  if (r) {
    toast(`Settings saved. ${r.note}${r.groupsCleared ? ` ${r.groupsCleared} staff were in a removed group and now have none.` : ''}`);
    document.dispatchEvent(new CustomEvent('oncall:dept-changed'));
  }
  loadSettings();
}

function renderBlocks() {
  const box = $('#settings-blocks');
  const blocks = settings.blocks;
  if (!blocks.length) return box.replaceChildren(emptyNote('No call times yet. Add the first one.'));
  box.replaceChildren(table(['Call time', 'Hours', 'Days', 'Calls', 'Status', { label: '', cls: 'actions' }], blocks.map((b) => [
    [el('strong', '', b.label), el('div', 'muted small', b.timeLabel)],
    String(b.hours),
    b.daysLabel,
    ['First call', 'First + second', 'First + second + third'][b.levels - 1],
    b.active ? el('span', 'ok-text', 'On') : el('span', 'muted', 'Off'),
    [btn('Edit', 'ghost', () => editBlock(b))],
  ])));
}

export async function editBlock(b = null) {
  const upcoming = b ? settings.upcomingByBlock[b.id] || 0 : 0;
  const res = await formDialog({
    title: b ? `Edit ${b.label}` : 'Add a call time',
    intro: upcoming ? `${upcoming} upcoming sign-up(s) use this call time. They keep their current times if you change them.` : null,
    fields: [
      { name: 'label', label: 'Name shown to staff', value: b?.label || '', placeholder: 'e.g. Evening, 3–7 PM, Weekend 24 h', maxLength: 40 },
      { name: 'startTime', label: 'Starts', type: 'time', value: b?.startTime || '15:00', half: true },
      { name: 'endTime', label: 'Ends', type: 'time', value: b?.endTime || '19:00', half: true, hint: 'If it ends earlier than it starts, it ends the next day. Same time = 24 hours.' },
      { name: 'days', label: 'Days', type: 'days', value: b?.days || [1, 2, 3, 4, 5] },
      { name: 'levels', label: 'Calls in this time', type: 'select', value: String(b?.levels || 1), options: [{ value: '1', label: 'First call only' }, { value: '2', label: 'First and second call' }, { value: '3', label: 'First, second and third call' }] },
      { name: 'sort', label: 'Order on the schedule', type: 'number', value: String(b?.sort ?? (settings.blocks.length + 1)), min: 0, max: 99, half: true },
      { name: 'active', label: 'On (staff can sign up)', type: 'checkbox', value: b ? b.active : true },
    ],
    extra: b ? {
      label: 'Delete',
      onClick: async () => {
        if (!(await confirmBox(`Delete ${b.label}?`, 'If it has past sign-ups it will be turned off instead, so history is kept.', 'Delete', true))) return false;
        return post(`manage/blocks/delete?${dq()}`, { id: b.id });
      },
    } : null,
    onSubmit: (v) => post(`manage/blocks?${dq()}`, { ...v, id: b?.id }),
  });
  if (res) toast(res.extra ? res.result?.note || 'Deleted.' : res.note || 'Saved.', res.note || res.result?.note ? 'info' : 'ok');
  loadSettings();
}

function renderShifts() {
  const box = $('#settings-shifts');
  const shifts = settings.shifts;
  box.replaceChildren();
  if (!shifts.length) {
    box.append(emptyNote('No shifts. Everyone on the staff list can take every call. Add shifts if different staff can take different calls (e.g. 7a–3p and 11a–7p).'));
    return;
  }
  box.append(table(['Shift', { label: '', cls: 'actions' }], shifts.map((s) => [
    s.name,
    [btn('Rename', 'ghost', () => editShift(s)), btn('Remove', 'ghost', () => removeShift(s))],
  ])));
}

export async function editShift(s = null) {
  const res = await formDialog({
    title: s ? 'Rename shift' : 'Add a shift',
    fields: [
      { name: 'name', label: 'Shift name', value: s?.name || '', placeholder: 'e.g. 7a–3p', maxLength: 40 },
      { name: 'sort', label: 'Order', type: 'number', value: String(s?.sort ?? settings.shifts.length + 1), min: 0, max: 99 },
    ],
    onSubmit: (v) => post(`manage/shifts?${dq()}`, { ...v, id: s?.id }),
  });
  if (res) toast(res.note || 'Saved.', res.note ? 'info' : 'ok');
  loadSettings();
}

async function removeShift(s) {
  if (!(await confirmBox(`Remove ${s.name}?`, 'Staff with this shift will have no shift until you set a new one, and can\'t sign up until then.', 'Remove', true))) return;
  const r = await attempt(() => post(`manage/shifts/delete?${dq()}`, { id: s.id }));
  if (r) toast(`Removed.${r.staffCleared ? ` ${r.staffCleared} staff need a new shift.` : ''}`);
  loadSettings();
}

function renderRules() {
  const box = $('#settings-rules');
  const blocks = settings.blocks.filter((b) => b.active);
  const shifts = settings.shifts;
  box.replaceChildren();
  $('#rules-save').hidden = true;
  if (!shifts.length) return box.append(emptyNote('Not needed: without shifts, everyone can take every call.'));
  if (!blocks.length) return box.append(emptyNote('Add a call time first.'));
  const opts = [['signup', 'Can sign up'], ['after_close', 'Vacancies only'], ['none', 'No']];
  const t = table(['Call time', ...shifts.map((s) => s.name)], blocks.map((b) => [
    [el('strong', '', b.label), el('div', 'muted small', b.timeLabel)],
    ...shifts.map((s) => {
      const sel = el('select', 'rule-select');
      sel.dataset.block = b.id;
      sel.dataset.shift = s.id;
      sel.setAttribute('aria-label', `${b.label} – ${s.name}`);
      for (const [v, l] of opts) {
        const o = el('option', '', l);
        o.value = v;
        sel.append(o);
      }
      sel.value = settings.rules[b.id]?.[s.id] || 'none';
      sel.dataset.v = sel.value;
      sel.addEventListener('change', () => {
        sel.dataset.v = sel.value;
        $('#rules-save').hidden = false;
      });
      return sel;
    }),
  ]), 'calls matrix');
  box.append(t);
}

export async function saveRules() {
  const rules = {};
  for (const sel of $$('#settings-rules select')) (rules[sel.dataset.block] ||= {})[sel.dataset.shift] = sel.value === 'none' ? null : sel.value;
  if (await attempt(() => post(`manage/rules?${dq()}`, { rules }))) toast('Saved who can take each call.');
  loadSettings();
}
