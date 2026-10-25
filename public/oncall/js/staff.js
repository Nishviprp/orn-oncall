// Staff screens: sign-up board, my calls, switches.
import {
  $, el, state, api, post, attempt, toast, confirmBox, dq, btn, emptyNote, table, printWith, printedAt, sentBy, formDialog,
} from './core.js';

// ---------- sign-up board ----------

export async function loadBoard(week, quiet = false) {
  if (!state.dept) return;
  const data = await attempt(() => api(`slots?${dq(week ? `&week=${encodeURIComponent(week)}` : '')}`), quiet);
  if (!data) return;
  state.week = data.weekStart;
  renderBoard(data);
}

function renderPeriodBanner(data) {
  const box = $('#period-banner');
  box.replaceChildren();
  const d = data.department;
  const you = data.you;
  const youParts = [];
  if (you?.group) youParts.push(`Group ${you.group}`);
  if (data.usesShifts) youParts.push(you?.shiftName ? `${you.shiftName} staff` : 'shift not set');
  const youLine = youParts.length ? `You: ${youParts.join(' · ')}` : '';

  if (!d.usePeriods) {
    box.append(el('strong', '', `${d.fullName} · Sign up any time`));
    if (youLine) box.append(el('div', 'small muted', youLine));
    box.hidden = false;
    return;
  }
  const p = data.periods[0] || null;
  const opensText = (per) => per.opens.map((o) => (o.group ? `Group ${o.group} opens ${o.label}` : `Opens ${o.label}`)).join(' · ');
  if (!p) {
    const next = data.upcomingPeriods[0];
    box.append(el('strong', '', next ? `Next call period: ${next.label}` : 'No call period is open for this week'));
    box.append(el('div', 'small', next ? `${opensText(next)} · Closes ${next.closesLabel}.` : 'Your nurse manager opens each period.'));
    if (youLine) box.append(el('div', 'small muted', youLine));
    box.hidden = false;
    return;
  }
  box.append(el('strong', '', `Call period ${p.label} · ${p.phaseLabel}`));
  box.append(el('div', 'small', `${opensText(p)} · Closes ${p.closesLabel}.`));
  if (data.member && d.minHours > 0) {
    const met = p.yourHours >= d.minHours;
    box.append(el('div', 'small', `Your call hours this period: ${p.yourHours} of ${d.minHours} required${met ? ' ✓' : ''}`));
    const prog = el('div', 'progress');
    const bar = el('div', 'progress-bar' + (met ? ' met' : ''));
    bar.style.width = Math.min(100, Math.round((p.yourHours / d.minHours) * 100)) + '%';
    prog.append(bar);
    box.append(prog);
  }
  if (youLine) box.append(el('div', 'small muted', youLine));
  box.hidden = false;
}

function renderBoard(data) {
  $('#week-label').textContent = data.weekLabel;
  $('#prev-week').disabled = !data.prevWeek;
  $('#next-week').disabled = !data.nextWeek;
  $('#prev-week').dataset.week = data.prevWeek || '';
  $('#next-week').dataset.week = data.nextWeek || '';
  $('#print-board').hidden = !data.manager;
  $('#board-summary').textContent = data.blocksSummary.length
    ? data.blocksSummary.map((b) => `${b.label} (${b.days}${b.levels > 1 ? `, ${b.levels} calls` : ''})`).join(' · ') + '. Tap an open slot to sign up.'
    : 'No call times are set up yet. A manager can add them under Manage → Settings.';
  renderPeriodBanner(data);

  const canBook = state.me?.fullName && data.member;
  const board = $('#board');
  if (!data.days.length) return board.replaceChildren(emptyNote('No calls this week.'));
  board.replaceChildren(...data.days.map((day) => {
    const card = el('article', 'day');
    const [weekday, ...rest] = day.label.split(', ');
    const head = el('header', 'day-head');
    head.append(el('div', 'day-name', weekday), el('div', 'day-date', rest.join(', ')));
    card.append(head);
    for (const blk of day.blocks) {
      const b = el('div', 'block');
      const title = el('div', 'block-time');
      title.append(el('span', '', blk.label), el('span', 'muted small', ` ${blk.timeLabel}`));
      b.append(title);
      const row = el('div', 'slot-row cols-' + Math.min(blk.roles.length, 3));
      for (const r of blk.roles) {
        let slot;
        if (r.status === 'open') {
          slot = el('button', 'slot open');
          slot.type = 'button';
          slot.disabled = !canBook;
          slot.append(el('span', 'slot-role', r.label), el('span', 'slot-state', 'Sign up'));
          slot.addEventListener('click', () => book(day, blk, r));
        } else {
          const labels = { mine: 'Your call', taken: 'Filled', past: 'Closed', locked: r.note || 'Not open to you' };
          slot = el('div', 'slot ' + r.status);
          slot.append(el('span', 'slot-role', r.label), el('span', 'slot-state', r.name && r.status !== 'mine' ? r.name : labels[r.status]));
          if (r.reason) {
            slot.title = r.reason;
            slot.tabIndex = 0;
            slot.addEventListener('click', () => toast(r.reason, 'info'));
          }
        }
        slot.setAttribute('aria-label', `${day.label}, ${blk.label} ${blk.timeLabel}, ${r.label}: ${slot.textContent}`);
        row.append(slot);
      }
      b.append(row);
      card.append(b);
    }
    return card;
  }));
}

async function book(day, blk, r) {
  if (!(await confirmBox('Confirm your call', `${r.label} · ${blk.label}\n${day.label}\n${blk.timeLabel}\n\nYou'll get a confirmation by email and text.`, 'Sign me up'))) return;
  state.busy = true;
  const res = await attempt(() => post('book', { blockId: blk.blockId, date: day.date, level: r.level }));
  state.busy = false;
  if (res) {
    const hrs = res.minHours ? ` ${res.hours} of ${res.minHours} hours this period.` : '';
    toast(`You're on call: ${r.label}, ${day.label}.${hrs}${sentBy(res.sent).replace('Sent', ' Confirmation sent')}`);
  }
  loadBoard(state.week);
}

export function printBoard() {
  printWith('print-board', `${$('#week-label').textContent} · Printed ${printedAt()}`);
}

// ---------- my calls ----------

export async function loadMine() {
  const data = await attempt(() => api('my-calls'));
  if (!data) return;
  const multi = new Set(data.calls.map((c) => c.departmentId)).size > 1 || (state.me?.departments.filter((d) => d.member).length || 0) > 1;
  const up = data.calls.filter((c) => c.upcoming);
  const past = data.calls.filter((c) => !c.upcoming).reverse();

  $('#mine-progress').replaceChildren(...data.progress.map((p) => {
    const row = el('div', 'progress-item');
    row.append(el('div', '', `${multi ? p.department + ' · ' : ''}${p.current ? 'Current' : 'Upcoming'} period ${p.label}: ${p.hours} of ${p.minHours} call hours${p.met ? ' ✓' : ''}`));
    const prog = el('div', 'progress');
    const bar = el('div', 'progress-bar' + (p.met ? ' met' : ''));
    bar.style.width = (p.minHours ? Math.min(100, Math.round((p.hours / p.minHours) * 100)) : 100) + '%';
    prog.append(bar);
    row.append(prog);
    return row;
  }));
  $('#mine-upcoming').replaceChildren(callTable(up, true, multi));
  $('#mine-past').replaceChildren(callTable(past, false, multi));
}

function callTable(calls, withActions, multi) {
  if (!calls.length) return emptyNote(withActions ? 'You have no upcoming calls.' : 'None.');
  const headers = ['Date', 'Time', 'Call'];
  if (multi) headers.push('Department');
  if (withActions) headers.push({ label: '', cls: 'no-print actions' });
  return table(headers, calls.map((c) => {
    const callCell = [el('div', '', `${c.roleLabel} · ${c.blockLabel}`)];
    if (c.stayStatus) {
      callCell.push(el('span', 'pill ' + (c.stayStatus === 'stay' ? 'pending_manager' : 'approved'), c.stayStatus === 'stay' ? 'Needed – please stay' : 'Released'));
      if (c.stayNote) callCell.push(el('div', 'muted small', c.stayNote));
    }
    const row = [c.dateLabel, c.timeLabel, callCell];
    if (multi) row.push(c.departmentName);
    if (withActions) {
      const acts = [];
      if (c.swap) {
        const who = c.swap.status === 'pending_colleague' ? `Waiting for ${c.swap.toName}` : `${c.swap.toName} accepted · waiting for manager`;
        acts.push(el('span', 'pill', `Switch: ${who}`), btn('Cancel switch', 'ghost', () => cancelSwitch(c.swap.id, c)));
      } else {
        if (c.canGiveAway) acts.push(btn('Give away', 'ghost', () => giveAway(c)));
        if (c.canRelease) acts.push(btn('Release', 'ghost', () => release(c)));
      }
      row.push(acts);
    }
    return row;
  }));
}

async function release(c) {
  if (!(await confirmBox('Release this call?', `${c.roleLabel} · ${c.blockLabel}\n${c.dateLabel}\n${c.timeLabel}\n\nThe slot will open for others.`, 'Release call', true))) return;
  if (await attempt(() => post('cancel', { id: c.id }))) toast('Call released. The slot is open again.');
  loadMine();
}

export function printMine() {
  printWith('print-mine', `${state.me?.fullName || ''} · Printed ${printedAt()}`);
}

// ---------- switches ----------

async function giveAway(c) {
  const data = await attempt(() => api(`colleagues?signupId=${encodeURIComponent(c.id)}`));
  if (!data) return;
  if (!data.colleagues.length) return toast('No colleague who can take this call has signed in to ON CALL yet.', 'error');
  const r = await formDialog({
    title: 'Give away this call',
    intro: `${c.roleLabel} · ${c.blockLabel} · ${c.dateLabel} · ${c.timeLabel}`,
    fields: [
      { name: 'to', label: 'Give it to', type: 'select', value: '', options: [{ value: '', label: 'Choose a colleague…' }, ...data.colleagues.map((p) => ({ value: p.id, label: p.shiftName ? `${p.name} (${p.shiftName})` : p.name }))] },
      { name: 'note', label: 'Note to your colleague (optional)', type: 'textarea', rows: 3, maxLength: 300 },
      { name: 'info', type: 'note', label: 'Your colleague gets an email and text to accept. You stay on call until the switch is complete.' },
    ],
    submitLabel: 'Send request',
    onSubmit: async (v) => {
      if (!v.to) throw new Error('Please choose a colleague.');
      await post('switches/request', { signupId: c.id, toUserId: v.to, note: v.note });
      return v;
    },
  });
  if (r) toast('Request sent. You stay on call until the switch is complete.');
  loadMine();
}

async function cancelSwitch(id, c) {
  if (!(await confirmBox('Cancel this switch?', c ? `${c.roleLabel} · ${c.blockLabel}\n${c.dateLabel}\n\nYou stay on call.` : 'You stay on call.', 'Cancel switch'))) return;
  if (await attempt(() => post('switches/cancel', { swapId: id }))) toast('Switch cancelled. You are still on call.');
  if (state.tab === 'mine') loadMine();
  else loadSwitches();
}

async function respond(s, accept) {
  const msg = `${s.call.roleLabel} · ${s.call.blockLabel}\n${s.call.dateLabel}\n${s.call.timeLabel}\n${s.call.departmentName}\nFrom ${s.fromName}`;
  if (!(await confirmBox(accept ? 'Accept this call?' : 'Decline this call?', msg, accept ? 'Accept' : 'Decline', !accept))) return;
  const r = await attempt(() => post('switches/respond', { swapId: s.id, accept }));
  if (r) toast(!accept ? 'Declined.' : r.status === 'approved' ? 'Accepted. The call is now yours.' : 'Accepted. Sent to the nurse manager for approval.');
  loadSwitches();
}

async function decide(s, approve) {
  const r = await formDialog({
    title: approve ? 'Approve switch?' : 'Deny switch?',
    intro: `${s.fromName} → ${s.toName} · ${s.call.roleLabel} · ${s.call.blockLabel} · ${s.call.dateLabel} · ${s.call.timeLabel}`,
    fields: [{ name: 'note', label: 'Note (optional, sent to both nurses)', type: 'textarea', rows: 2, maxLength: 300 }],
    submitLabel: approve ? 'Approve' : 'Deny',
    onSubmit: (v) => post('switches/decide', { swapId: s.id, approve, note: v.note }),
  });
  if (r) toast(approve ? `Approved. ${s.toName} is now on call, and both nurses were told.` : 'Switch denied. Both nurses were told.');
  loadSwitches();
}

function switchCard(s, actions = []) {
  const card = el('div', 'sw-card');
  const top = el('div', 'sw-top');
  top.append(el('div', 'sw-call', `${s.call.roleLabel} · ${s.call.blockLabel} · ${s.call.dateLabel} · ${s.call.timeLabel}`));
  top.append(el('span', 'pill ' + s.status, s.statusLabel));
  card.append(top);
  card.append(el('div', 'sw-who', `${s.fromName} → ${s.toName}`));
  card.append(el('div', 'muted small', s.call.departmentName));
  if (s.note) card.append(el('div', 'muted small', `Note: "${s.note}"`));
  if (s.managerName && (s.status === 'approved' || s.status === 'denied')) {
    card.append(el('div', 'muted small', `${s.status === 'approved' ? 'Approved' : 'Denied'} by ${s.managerName}${s.managerNote ? `: "${s.managerNote}"` : ''}`));
  }
  if (actions.length) {
    const row = el('div', 'sw-actions');
    for (const [label, cls, fn] of actions) row.append(btn(label, cls, fn));
    card.append(row);
  }
  return card;
}

export async function loadSwitches() {
  const data = await attempt(() => api('switches'));
  if (!data) return;
  renderBadge(data.incoming.length + data.approvals.length);
  $('#sw-incoming').replaceChildren(...(data.incoming.length
    ? data.incoming.map((s) => switchCard(s, [['Accept', 'primary', () => respond(s, true)], ['Decline', 'ghost', () => respond(s, false)]]))
    : [emptyNote('No requests right now.')]));
  $('#sw-mine').replaceChildren(...(data.mine.length
    ? data.mine.map((s) => switchCard(s, s.iAmFrom && ['pending_colleague', 'pending_manager'].includes(s.status) ? [['Cancel switch', 'ghost', () => cancelSwitch(s.id)]] : []))
    : [emptyNote('No switches yet.')]));
  $('#approvals-wrap').hidden = !data.manager;
  $('#decided-wrap').hidden = !data.manager;
  if (data.manager) {
    $('#sw-approvals').replaceChildren(...(data.approvals.length
      ? data.approvals.map((s) => switchCard(s, s.involvesMe ? [] : [['Approve', 'primary', () => decide(s, true)], ['Deny', 'ghost', () => decide(s, false)]]))
      : [emptyNote('Nothing waiting for approval.')]));
    $('#sw-decided').replaceChildren(...(data.decided.length ? data.decided.map((s) => switchCard(s)) : [emptyNote('None in the last 30 days.')]));
  }
}

export function renderBadge(n) {
  const b = $('#switch-badge');
  b.textContent = n > 0 ? String(n) : '';
  b.hidden = !(n > 0);
}
