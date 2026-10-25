// Email and text wording. `call` comes from describeCall(); it carries the department name.
import { siteLink } from './lib.mjs';

export const firstName = (n) => (n ? String(n).trim().split(/\s+/)[0] : '');

// kind: confirm | day | hour | cancel | stay | released
//       swap_request | swap_accepted | swap_declined | swap_manager | swap_approved_from | swap_approved_to
//       swap_confirmed_from | swap_confirmed_to | swap_denied | swap_cancelled | swap_expired
export function buildMessage(kind, name, call, ctx = {}) {
  const when = `${call.dateLabel}, ${call.timeLabel}`;
  const what = `${call.roleLabel} (${call.blockLabel})`;
  const short = `${call.roleLabel} ${call.blockLabel}, ${when}`;
  const hi = name ? `Hi ${firstName(name)},` : 'Hi,';
  const link = siteLink(kind.startsWith('swap') ? '#switches' : '', call.departmentId);
  const from = ctx.from || 'A colleague';
  const to = ctx.to || 'your colleague';
  const day = ctx.isToday ? 'today' : `on ${call.dateLabel}`;
  const dayShort = ctx.isToday ? 'today' : call.dateLabel;
  const map = {
    confirm: {
      subject: `On call confirmed: ${call.roleLabel}, ${call.dateLabel}`,
      lines: [
        hi,
        `You are confirmed for ${what} on ${when}.`,
        ctx.hours !== undefined && ctx.minHours ? `You now have ${ctx.hours} of ${ctx.minHours} required call hours for ${ctx.periodLabel}.` : null,
        `You'll get a reminder on the morning of your call and again before it starts.`,
        `View or print your schedule: ${link}`,
      ],
      sms: `ORN Global: Confirmed – ${short}.`,
    },
    day: {
      subject: `Reminder: you're on call today – ${call.timeLabel}`,
      lines: [hi, `Reminder: you are on ${what} today, ${when}.`, `Your schedule: ${link}`],
      sms: `ORN Global reminder: you're on ${call.roleLabel} ${call.blockLabel} today, ${call.timeLabel}.`,
    },
    hour: {
      subject: `Your on call starts soon – ${call.timeLabel}`,
      lines: [hi, `Your ${what} starts in about ${ctx.minutes || 60} minutes (${when}).`, `Your schedule: ${link}`],
      sms: `ORN Global: your ${call.roleLabel} ${call.blockLabel} starts in about ${ctx.minutes || 60} min (${call.timeLabel}).`,
    },
    cancel: {
      subject: `On call released: ${call.roleLabel}, ${call.dateLabel}`,
      lines: [hi, `You released your ${what} on ${when}. This slot is open again.`, `Your schedule: ${link}`],
      sms: `ORN Global: you released ${short}.`,
    },
    stay: {
      subject: `Please stay for call ${dayShort} – ${call.timeLabel}`,
      lines: [hi, `You're needed: please stay for your ${what} ${day}, ${call.timeLabel}.`, ctx.note ? `Note from your manager: "${ctx.note}"` : null, `Your schedule: ${link}`],
      sms: `ORN Global: please STAY for your ${call.roleLabel} ${dayShort}, ${call.timeLabel}.${ctx.note ? ' ' + ctx.note : ''}`,
    },
    released: {
      subject: `You're released from call ${dayShort}`,
      lines: [hi, `You don't need to stay for your ${what} ${day} (${call.timeLabel}). You're released.`, ctx.note ? `Note from your manager: "${ctx.note}"` : null, `Your schedule: ${link}`],
      sms: `ORN Global: you're RELEASED from your ${call.roleLabel} ${dayShort} (${call.timeLabel}). No need to stay.${ctx.note ? ' ' + ctx.note : ''}`,
    },
    swap_request: {
      subject: `${from} wants to give you a call: ${call.dateLabel}`,
      lines: [hi, `${from} would like to give you their ${what} on ${when}.`, ctx.note ? `Note from ${firstName(from)}: "${ctx.note}"` : null, `Accept or decline here: ${link}`, ctx.needsApproval === false ? null : `If you accept, it goes to your nurse manager for approval.`],
      sms: `ORN Global: ${from} wants to give you their ${short}. Accept or decline: ${link}`,
    },
    swap_accepted: {
      subject: `${to} accepted your call – waiting for manager approval`,
      lines: [hi, `${to} accepted your ${what} on ${when}.`, `It is now waiting for manager approval. You stay on call until the switch is approved.`, `Status: ${link}`],
      sms: `ORN Global: ${to} accepted your ${short}. Waiting for manager approval – you stay on call until approved.`,
    },
    swap_declined: {
      subject: `${to} declined your call switch`,
      lines: [hi, `${to} declined your request to switch your ${what} on ${when}.`, `You are still on call. You can ask another colleague: ${link}`],
      sms: `ORN Global: ${to} declined your switch for ${short}. You are still on call.`,
    },
    swap_manager: {
      subject: `Switch needs your approval: ${call.dateLabel}`,
      lines: [hi, `${from} is giving their ${what} on ${when} to ${to}, and ${firstName(to)} has accepted.`, `Approve or deny: ${link}`],
      sms: `ORN Global: approve switch? ${from} → ${to}, ${short}. ${link}`,
    },
    swap_approved_from: {
      subject: `Your switch has been approved`,
      lines: [hi, `Your switch has been approved.`, `Your ${what} on ${when} now belongs to ${to}. You are no longer on call for it.`, `Your schedule: ${link}`],
      sms: `ORN Global: Your switch has been approved. ${short} now belongs to ${to}.`,
    },
    swap_approved_to: {
      subject: `Your switch has been approved`,
      lines: [hi, `Your switch has been approved.`, `You are now on call: ${what}, ${when} (from ${from}).`, `You'll get the usual reminders before the call.`, `Your schedule: ${link}`],
      sms: `ORN Global: Your switch has been approved. You're now on call: ${short}.`,
    },
    swap_confirmed_from: {
      subject: `Your switch is confirmed`,
      lines: [hi, `${to} accepted your call. Your switch is confirmed.`, `Your ${what} on ${when} now belongs to ${to}.`, `Your schedule: ${link}`],
      sms: `ORN Global: switch confirmed. ${short} now belongs to ${to}.`,
    },
    swap_confirmed_to: {
      subject: `Your switch is confirmed`,
      lines: [hi, `Your switch is confirmed. You are now on call: ${what}, ${when} (from ${from}).`, `Your schedule: ${link}`],
      sms: `ORN Global: switch confirmed. You're now on call: ${short}.`,
    },
    swap_denied: {
      subject: `Your switch was not approved`,
      lines: [hi, `Your nurse manager did not approve the switch of ${what} on ${when} from ${from} to ${to}.`, ctx.note ? `Manager's note: "${ctx.note}"` : null, `${from} remains on call.`, `Details: ${link}`],
      sms: `ORN Global: switch not approved for ${short}. ${from} remains on call.`,
    },
    swap_cancelled: {
      subject: `Call switch cancelled`,
      lines: [hi, `${from} cancelled the switch request for ${what} on ${when}. ${from} remains on call.`, `Details: ${link}`],
      sms: `ORN Global: ${from} cancelled the switch for ${short}.`,
    },
    swap_expired: {
      subject: `Call switch expired`,
      lines: [hi, `The switch request for ${what} on ${when} was not completed before the call started, so ${from} remains on call.`],
      sms: `ORN Global: switch for ${short} expired. ${from} remains on call.`,
    },
  };
  const m = map[kind];
  if (!m) throw new Error('Unknown message ' + kind);
  return { ...m, dept: call.departmentName, lines: m.lines.filter(Boolean) };
}

// Messages not tied to one call.
// signup_open: ctx { dept, deptId, group, periodLabel, closesLabel, minHours, extra }
// vacancies:   ctx { dept, deptId, count, periodLabel }
export function buildNotice(kind, name, ctx = {}) {
  const hi = name ? `Hi ${firstName(name)},` : 'Hi,';
  const link = siteLink('', ctx.deptId);
  const who = ctx.group ? ` for Group ${ctx.group}` : '';
  if (kind === 'signup_open') {
    return {
      dept: ctx.dept,
      subject: `Call sign-up is open${who}: ${ctx.periodLabel}`,
      lines: [
        hi,
        `Call sign-up for ${ctx.periodLabel} (${ctx.dept}) is now open${who}.`,
        `Sign-up closes ${ctx.closesLabel}.` + (ctx.minHours ? ` The requirement is at least ${ctx.minHours} call hours in this period.` : ''),
        ctx.extra || null,
        `Sign up: ${link}`,
      ].filter(Boolean),
      sms: `ORN Global: call sign-up for ${ctx.periodLabel} is open${who}. Closes ${ctx.closesLabel}. ${link}`,
    };
  }
  if (kind === 'vacancies') {
    const s = ctx.count === 1 ? 'slot' : 'slots';
    return {
      dept: ctx.dept,
      subject: `${ctx.count} open call ${s} you can now take`,
      lines: [hi, `Sign-up has closed for ${ctx.periodLabel} (${ctx.dept}), and ${ctx.count} call ${s} you're eligible for ${ctx.count === 1 ? 'is' : 'are'} still open.`, `You can sign up for them now.`, `Sign up: ${link}`],
      sms: `ORN Global: ${ctx.count} open call ${s} for ${ctx.periodLabel} you can take now: ${link}`,
    };
  }
  throw new Error('Unknown notice ' + kind);
}
