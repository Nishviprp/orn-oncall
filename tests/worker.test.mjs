// Checks the Worker's routing without any outside services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';

const env = (extra = {}) => ({
  ASSETS: { fetch: async (req) => new Response('asset:' + new URL(req.url).pathname) },
  ...extra,
});

test('home page redirects to ON CALL', async () => {
  const r = await worker.fetch(new Request('https://oncall.example.com/'), env());
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), 'https://oncall.example.com/oncall/');
});

test('home redirect can be turned off', async () => {
  const r = await worker.fetch(new Request('https://x.example.com/'), env({ REDIRECT_HOME: 'false' }));
  assert.equal(await r.text(), 'asset:/');
});

test('page files come from static assets', async () => {
  const r = await worker.fetch(new Request('https://x.example.com/oncall/app.js'), env());
  assert.equal(await r.text(), 'asset:/oncall/app.js');
});

test('config reports missing setup clearly', async () => {
  const r = await worker.fetch(new Request('https://x.example.com/api/oncall/config'), env());
  assert.equal(r.status, 500);
  assert.match((await r.json()).error, /not set up/);
});

test('config returns public settings only', async () => {
  const r = await worker.fetch(
    new Request('https://x.example.com/api/oncall/config'),
    env({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_ANON_KEY: 'anon', SUPABASE_SERVICE_ROLE_KEY: 'secret', PHONE_LOGIN_ENABLED: 'true' }),
  );
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.supabaseAnonKey, 'anon');
  assert.equal(body.phoneLogin, true);
  assert.ok(!JSON.stringify(body).includes('secret'));
});

test('API needs sign-in', async () => {
  const r = await worker.fetch(
    new Request('https://x.example.com/api/oncall/switches'),
    env({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
  );
  assert.equal(r.status, 401);
});

test('unknown routes and wrong methods', async () => {
  assert.equal((await worker.fetch(new Request('https://x.example.com/api/oncall/nope'), env())).status, 404);
  assert.equal((await worker.fetch(new Request('https://x.example.com/api/oncall/book'), env())).status, 405);
});

test('POSTs from another website are blocked', async () => {
  const r = await worker.fetch(
    new Request('https://x.example.com/api/oncall/switches/decide', { method: 'POST', headers: { origin: 'https://evil.example' }, body: '{}' }),
    env(),
  );
  assert.equal(r.status, 403);
});

test('manager, admin and staff routes need sign-in', async () => {
  for (const path of ['manage/today?d=00000000-0000-0000-0000-000000000001', 'manage/settings?d=00000000-0000-0000-0000-000000000001', 'manage/staff?d=00000000-0000-0000-0000-000000000001', 'admin/tree', 'me', 'my-calls']) {
    const r = await worker.fetch(
      new Request('https://x.example.com/api/oncall/' + path),
      env({ SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' }),
    );
    assert.equal(r.status, 401, path);
  }
});
