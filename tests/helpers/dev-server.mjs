// Local preview server for testing the page in a browser without Supabase:
// serves public/ and the real API (src/) backed by an in-memory PostgreSQL with sample data.
// Usage: node tests/helpers/dev-server.mjs [port]
// Sign-in is faked: the page's Supabase client is replaced by the browser test, which passes
// the token ("boss", "mgr", "a", "b", "c", "west") as the user.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';
import worker from '../../src/worker.mjs';
import { setDbForTests, todayInTz, addDays, isoDay } from '../../src/lib.mjs';
import { fakeSupabase, SUPABASE_LIKE_PARSERS } from './fake-supabase.mjs';

const ROOT = new URL('../../public/', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
const port = Number(process.argv[2] || 8787);

const ASSETS = {
  async fetch(req) {
    let path = decodeURIComponent(new URL(req.url).pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) return new Response('no', { status: 403 });
    try {
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] || 'text/plain' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  },
};
const ENV = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'svc', SITE_URL: `http://localhost:${port}`, REDIRECT_HOME: 'true', ASSETS };

const id = (n) => `00000000-0000-0000-0000-0000000002${String(n).padStart(2, '0')}`;
const PEOPLE = {
  boss: { id: id(1), email: 'boss@example.com' },
  mgr: { id: id(2), email: 'mgr@example.com' },
  a: { id: id(3), email: 'ayana@example.com' },
  b: { id: id(4), email: 'juan@example.com' },
  c: { id: id(5), email: 'kayla@example.com', phone: '17325550101' },
  west: { id: id(6), email: 'west@example.com' },
};

const pg = new PGlite({ extensions: { btree_gist }, parsers: SUPABASE_LIKE_PARSERS });
await pg.exec(`create schema auth; create table auth.users (id uuid primary key); create role anon; create role authenticated; create role service_role;`);
await pg.exec((await readFile(new URL('../../supabase/schema.sql', import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', ''));
for (const p of Object.values(PEOPLE)) await pg.query('insert into auth.users (id) values ($1)', [p.id]);
await pg.query(`insert into oc_admins (scope, full_name, email) values ('system', 'Sam Admin', 'boss@example.com')`);
setDbForTests(fakeSupabase(pg, new Map(Object.entries(PEOPLE))));
globalThis.fetch = async () => new Response('{}', { status: 200 }); // swallow emails/texts

async function call(who, method, path, body) {
  const res = await worker.fetch(new Request(`http://localhost:${port}/api/oncall/${path}`, {
    method, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  }), ENV);
  const json = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error}`);
  return json;
}

// ---------- sample data ----------
const org = (await call('boss', 'POST', 'admin/orgs', { name: 'Garden State Health' })).id;
const nj = (await call('boss', 'POST', 'admin/hospitals', { orgId: org, name: 'Morris Cancer Center', state: 'NJ', city: 'Morristown' })).id;
const ca = (await call('boss', 'POST', 'admin/hospitals', { orgId: org, name: 'Bay Medical', state: 'CA', city: 'Oakland' })).id;
const or = (await call('boss', 'POST', 'admin/departments', { hospitalId: nj, name: 'OR', template: 'or_call_sheet', managerName: 'Pat Manager', managerEmail: 'mgr@example.com' })).id;
await call('boss', 'POST', 'admin/departments', { hospitalId: nj, name: 'Endoscopy', template: 'simple_evening' });
const cath = (await call('boss', 'POST', 'admin/departments', { hospitalId: ca, name: 'Cath Lab', template: 'weekend_24h', managerName: 'Wes West', managerEmail: 'west@example.com' })).id;
await call('boss', 'POST', 'admin/admins', { scope: 'hospital', hospitalId: ca, fullName: 'Wes West', email: 'west@example.com' });

await call('mgr', 'POST', `manage/staff/import?d=${or}`, {
  text: 'Ayana Akbar, ayana@example.com, A, 7a–3p\nJuan Miranda, juan@example.com, B, 11a–7p\nKayla Strych, kayla@example.com, (732) 555-0101, B, 7a–3p\nYoung Lim, young@example.com, A, 11a–7p',
});
await call('west', 'POST', `manage/staff?d=${cath}`, { fullName: 'Ayana Akbar', email: 'ayana@example.com' });
for (const [who, name] of [['boss', 'Sam Admin'], ['mgr', 'Pat Manager'], ['a', 'Ayana Akbar'], ['b', 'Juan Miranda'], ['c', 'Kayla Strych'], ['west', 'Wes West']]) {
  await call(who, 'POST', 'me', { full_name: name });
}

const TZ = 'America/New_York';
const today = todayInTz(new Date(), TZ);
const weekday = (n) => { let d = addDays(today, n); while (isoDay(d) === 7) d = addDays(d, 1); return d; };
await call('mgr', 'POST', `manage/periods?d=${or}`, { startDate: today, signupStart: addDays(today, -2), groupOrder: ['A', 'B'] });
const s = await call('mgr', 'GET', `manage/settings?d=${or}`);
const early = s.blocks.find((b) => b.label === '3–7 PM').id;
const late = s.blocks.find((b) => b.label === '7–11 PM').id;
const d1 = weekday(2), d2 = weekday(3), d3 = weekday(4);
await call('a', 'POST', 'book', { blockId: early, date: d1, level: 1 });
await call('c', 'POST', 'book', { blockId: early, date: d1, level: 2 });
await call('b', 'POST', 'book', { blockId: late, date: d1, level: 1 });
const mine = await call('a', 'POST', 'book', { blockId: early, date: d2, level: 1 });
await call('c', 'POST', 'book', { blockId: late, date: d3, level: 1 });
const sw = await call('a', 'POST', 'switches/request', { signupId: mine.call.id, toUserId: PEOPLE.c.id, note: 'Family event' });
await call('c', 'POST', 'switches/respond', { swapId: sw.swapId, accept: true });

http.createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const r = await worker.fetch(new Request(`http://localhost:${port}${req.url}`, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }), ENV);
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
}).listen(port, () => console.log(`READY http://localhost:${port}/oncall/ (OR=${or})`));
