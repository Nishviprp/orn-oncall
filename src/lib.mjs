// Shared helpers for the ORN Global ON CALL Worker.
import { createClient } from '@supabase/supabase-js';

// ---------- settings (Cloudflare passes these in as `env`) ----------

let ENV = {};
let admin = null;
export function setEnv(env) {
  if (env !== ENV) admin = null;
  ENV = env || {};
}
export const env = () => ENV;

export function settings() {
  return {
    phoneLogin: String(ENV.PHONE_LOGIN_ENABLED ?? 'false') === 'true',
  };
}

export const LEVELS = { 1: 'First call', 2: 'Second call', 3: 'Third call' };
export const DAY_NAMES = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

// US states and territories → main time zone (editable per hospital).
export const US_STATES = {
  AL: ['Alabama', 'America/Chicago'], AK: ['Alaska', 'America/Anchorage'], AZ: ['Arizona', 'America/Phoenix'],
  AR: ['Arkansas', 'America/Chicago'], CA: ['California', 'America/Los_Angeles'], CO: ['Colorado', 'America/Denver'],
  CT: ['Connecticut', 'America/New_York'], DE: ['Delaware', 'America/New_York'], DC: ['District of Columbia', 'America/New_York'],
  FL: ['Florida', 'America/New_York'], GA: ['Georgia', 'America/New_York'], HI: ['Hawaii', 'Pacific/Honolulu'],
  ID: ['Idaho', 'America/Boise'], IL: ['Illinois', 'America/Chicago'], IN: ['Indiana', 'America/Indiana/Indianapolis'],
  IA: ['Iowa', 'America/Chicago'], KS: ['Kansas', 'America/Chicago'], KY: ['Kentucky', 'America/New_York'],
  LA: ['Louisiana', 'America/Chicago'], ME: ['Maine', 'America/New_York'], MD: ['Maryland', 'America/New_York'],
  MA: ['Massachusetts', 'America/New_York'], MI: ['Michigan', 'America/Detroit'], MN: ['Minnesota', 'America/Chicago'],
  MS: ['Mississippi', 'America/Chicago'], MO: ['Missouri', 'America/Chicago'], MT: ['Montana', 'America/Denver'],
  NE: ['Nebraska', 'America/Chicago'], NV: ['Nevada', 'America/Los_Angeles'], NH: ['New Hampshire', 'America/New_York'],
  NJ: ['New Jersey', 'America/New_York'], NM: ['New Mexico', 'America/Denver'], NY: ['New York', 'America/New_York'],
  NC: ['North Carolina', 'America/New_York'], ND: ['North Dakota', 'America/Chicago'], OH: ['Ohio', 'America/New_York'],
  OK: ['Oklahoma', 'America/Chicago'], OR: ['Oregon', 'America/Los_Angeles'], PA: ['Pennsylvania', 'America/New_York'],
  RI: ['Rhode Island', 'America/New_York'], SC: ['South Carolina', 'America/New_York'], SD: ['South Dakota', 'America/Chicago'],
  TN: ['Tennessee', 'America/Chicago'], TX: ['Texas', 'America/Chicago'], UT: ['Utah', 'America/Denver'],
  VT: ['Vermont', 'America/New_York'], VA: ['Virginia', 'America/New_York'], WA: ['Washington', 'America/Los_Angeles'],
  WV: ['West Virginia', 'America/New_York'], WI: ['Wisconsin', 'America/Chicago'], WY: ['Wyoming', 'America/Denver'],
  PR: ['Puerto Rico', 'America/Puerto_Rico'], GU: ['Guam', 'Pacific/Guam'], VI: ['U.S. Virgin Islands', 'America/St_Thomas'],
};

export const TIME_ZONES = {
  'America/New_York': 'Eastern',
  'America/Detroit': 'Eastern (Michigan)',
  'America/Indiana/Indianapolis': 'Eastern (Indiana)',
  'America/Chicago': 'Central',
  'America/Denver': 'Mountain',
  'America/Boise': 'Mountain (Idaho)',
  'America/Phoenix': 'Arizona (no daylight saving)',
  'America/Los_Angeles': 'Pacific',
  'America/Anchorage': 'Alaska',
  'Pacific/Honolulu': 'Hawaii',
  'America/Puerto_Rico': 'Atlantic (Puerto Rico)',
  'America/St_Thomas': 'Atlantic (Virgin Islands)',
  'Pacific/Guam': 'Chamorro (Guam)',
};

// ---------- HTTP helpers ----------

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

export const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SECURITY_HEADERS },
  });

export async function readJson(req) {
  try {
    const body = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'Invalid request.');
  }
}

export const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function needUuid(s, what = 'request') {
  if (!isUuid(s)) throw new HttpError(400, `Invalid ${what}.`);
  return s;
}

export const cleanText = (v, max = 300) => {
  if (v === null || v === undefined) return null;
  const t = String(v).replace(/\s+/g, ' ').trim().slice(0, max);
  return t || null;
};

// ---------- database and sign-in ----------

// Tests swap in a stand-in client backed by an in-memory database.
let testClient = null;
export function setDbForTests(client) {
  testClient = client;
}

export function db() {
  if (testClient) return testClient;
  if (!admin) {
    if (!ENV.SUPABASE_URL || !ENV.SUPABASE_SERVICE_ROLE_KEY) {
      throw new HttpError(500, 'Server is missing its Supabase settings.');
    }
    admin = createClient(ENV.SUPABASE_URL, ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}

// Throws the database error if there is one, otherwise returns the data.
export function must({ data, error }) {
  if (error) throw error;
  return data;
}

export async function requireUser(req) {
  const h = req.headers.get('authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please sign in.');
  const { data, error } = await db().auth.getUser(token);
  if (error || !data?.user) throw new HttpError(401, 'Your session has expired. Please sign in again.');
  return data.user;
}

export const phoneE164 = (p) => (p ? '+' + String(p).replace(/[^\d]/g, '') : null);

export function contactFor(user) {
  return { email: user?.email ? user.email.toLowerCase() : null, phone: user?.phone ? phoneE164(user.phone) : null };
}

export function normEmail(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const e = String(v).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) || e.length > 200) throw new HttpError(400, 'Please enter a valid email address.');
  return e;
}

export function normPhone(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const raw = String(v).trim();
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && d.length >= 8 && d.length <= 15 && d[0] !== '0') return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  throw new HttpError(400, 'Please enter a valid mobile number.');
}

// Does a staff/admin row belong to this contact (email or phone)?
export const matchesContact = (row, c) =>
  Boolean((c.email && row.email && row.email === c.email.toLowerCase()) || (c.phone && row.phone && row.phone === c.phone));

export async function getProfile(userId) {
  return must(await db().from('oc_profiles').select('id, full_name, email, phone').eq('id', userId).maybeSingle());
}

export async function namesFor(ids) {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return {};
  const rows = must(await db().from('oc_profiles').select('id, full_name').in('id', unique));
  return Object.fromEntries(rows.map((p) => [p.id, p.full_name]));
}

export async function personFor(userId) {
  const [{ data: u }, profile] = await Promise.all([db().auth.admin.getUserById(userId), getProfile(userId)]);
  return { id: userId, name: profile?.full_name || 'A colleague', contact: u?.user ? contactFor(u.user) : null };
}

// ---------- dates and time zones ('YYYY-MM-DD' in the department's time zone) ----------

export function tzOffsetMinutes(date, zone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = Object.fromEntries(dtf.formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

// Local wall-clock time in `zone` → the real instant.
export function zonedToUtc(dateStr, timeStr, zone) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMinutes(new Date(guess), zone);
  let t = guess - off1 * 60000;
  const off2 = tzOffsetMinutes(new Date(t), zone);
  if (off2 !== off1) t = guess - off2 * 60000;
  return new Date(t);
}

export function todayInTz(now, zone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function hourInTz(now, zone) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: '2-digit', hourCycle: 'h23' }).format(now)) % 24;
}

export function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export const isValidTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d(:00)?$/.test(s);
export const hhmm = (t) => String(t).slice(0, 5);

export const dayOfWeek = (s) => new Date(s + 'T12:00:00Z').getUTCDay(); // 0 = Sunday
export const isoDay = (s) => dayOfWeek(s) || 7; // 1 = Monday … 7 = Sunday

export function addDays(s, n) {
  const d = new Date(s + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export const mondayOf = (s) => addDays(s, 1 - isoDay(s));

export function formatDateLong(s) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
  }).format(new Date(s + 'T12:00:00Z'));
}

export function formatDateShort(s) {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(s + 'T12:00:00Z'));
}

export function formatWhen(iso, zone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: zone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(new Date(iso));
}

export function formatShortWhen(iso, zone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', hour: 'numeric', minute: '2-digit' })
      .formatToParts(new Date(iso)).map((x) => [x.type, x.value]),
  );
  return `${p.weekday} ${p.hour}${p.minute === '00' ? '' : ':' + p.minute} ${p.dayPeriod}`;
}

// "3:00 PM" from '15:00'
export function clockLabel(t) {
  const [h, m] = hhmm(t).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// "3:00 PM – 7:00 PM", "7:00 PM – 7:00 AM (next day)"
export function timeRangeLabel(start, end) {
  const crosses = hhmm(end) <= hhmm(start);
  return `${clockLabel(start)} – ${clockLabel(end)}${crosses ? ' (next day)' : ''}`;
}

export function rangeFromInstants(startIso, endIso, zone) {
  const f = (iso) => new Intl.DateTimeFormat('en-US', { timeZone: zone, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  return timeRangeLabel(f(startIso), f(endIso));
}

// ---------- email (Resend) and text messages (Twilio) ----------

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function sendEmail(to, subject, text, html) {
  if (!to) return 'skipped';
  if (!ENV.RESEND_API_KEY || !ENV.EMAIL_FROM) {
    console.warn('Email not configured: set RESEND_API_KEY and EMAIL_FROM');
    return 'not-configured';
  }
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${ENV.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: ENV.EMAIL_FROM, to: [to], subject, text, html }),
  });
  if (!r.ok) {
    console.error('Email failed', r.status, await r.text());
    return 'failed';
  }
  return 'sent';
}

export async function sendSms(to, body) {
  if (!to) return 'skipped';
  const sid = ENV.TWILIO_ACCOUNT_SID;
  const token = ENV.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !(ENV.TWILIO_FROM || ENV.TWILIO_MESSAGING_SERVICE_SID)) {
    console.warn('Text messages not configured: set TWILIO_* settings');
    return 'not-configured';
  }
  const params = new URLSearchParams({ To: to, Body: body });
  if (ENV.TWILIO_MESSAGING_SERVICE_SID) params.set('MessagingServiceSid', ENV.TWILIO_MESSAGING_SERVICE_SID);
  else params.set('From', ENV.TWILIO_FROM);
  const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + btoa(`${sid}:${token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!r.ok) {
    console.error('Text message failed', r.status, await r.text());
    return 'failed';
  }
  return 'sent';
}

export async function notify(contact, msg) {
  if (!contact) return { email: 'skipped', sms: 'skipped' };
  const text = msg.lines.join('\n\n');
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2933">` +
    `<p style="margin:0 0 16px;font-weight:bold;color:#0f4c81">ORN Global · ON CALL${msg.dept ? ' · ' + escapeHtml(msg.dept) : ''}</p>` +
    msg.lines.map((l) => `<p style="margin:0 0 12px">${escapeHtml(l)}</p>`).join('') +
    `</div>`;
  const [email, sms] = await Promise.all([
    sendEmail(contact.email, msg.subject, text, html).catch((e) => (console.error(e), 'failed')),
    sendSms(contact.phone, `${msg.sms} Reply STOP to opt out.`).catch((e) => (console.error(e), 'failed')),
  ]);
  return { email, sms };
}

export const siteLink = (hash = '', deptId = null) =>
  `${(ENV.SITE_URL || 'https://ornglobal.com').replace(/\/$/, '')}/oncall/${deptId ? '?d=' + deptId : ''}${hash}`;
