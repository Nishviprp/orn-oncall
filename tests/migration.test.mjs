// The migration from the earlier single-department version moves everything across intact.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const read = async (f) => (await readFile(new URL('../supabase/' + f, import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', '');

test('earlier data moves into one department in the new structure', async () => {
  const pg = new PGlite({ extensions: { btree_gist } });
  await pg.exec(`create schema auth; create table auth.users (id uuid primary key); create role anon; create role authenticated; create role service_role;`);
  await pg.exec(await read('legacy/v3-schema.sql'));
  const A = '00000000-0000-0000-0000-00000000000a', B = '00000000-0000-0000-0000-00000000000b';
  await pg.exec(`
    insert into auth.users values ('${A}'), ('${B}');
    insert into oncall_profiles (id, full_name, email) values ('${A}', 'Ayana Akbar', 'a@x.com'), ('${B}', 'Juan Miranda', 'b@x.com');
    insert into oncall_allowlist (full_name, email, group_name, shift) values ('Ayana Akbar', 'a@x.com', 'A', 'day'), ('Juan Miranda', 'b@x.com', 'B', 'mid');
    insert into oncall_allowlist (full_name, group_name) values ('Roster Only', 'B');
    insert into oncall_allowlist (full_name, email, is_manager) values ('Pat Manager', 'mgr@x.com', true);
    insert into oncall_periods (start_date, end_date, first_group, signup_saturday, first_opens_at, second_opens_at, closes_at, first_notice_sent_at)
      values ('2030-02-04', '2030-03-17', 'B', '2030-01-26', '2030-01-26T13:00Z', '2030-01-27T13:00Z', '2030-01-28T05:00Z', now());
    insert into oncall_signups (id, user_id, shift_date, block, role, start_at, end_at)
      values ('00000000-0000-0000-0000-0000000000c1', '${A}', '2030-02-05', 'early', 'secondary', '2030-02-05T20:00Z', '2030-02-06T00:00Z');
  `);
  await pg.exec(`
    insert into oncall_signups (id, user_id, shift_date, block, role, start_at, end_at)
      values ('00000000-0000-0000-0000-0000000000c2', '${B}', '2030-02-05', 'late', 'primary', '2030-02-06T00:00Z', '2030-02-06T04:00Z');
    insert into oncall_swaps (signup_id, from_user, to_user, status, shift_date, block, role, start_at)
      values ('00000000-0000-0000-0000-0000000000c2', '${B}', '${A}', 'pending_manager', '2030-02-05', 'late', 'primary', '2030-02-06T00:00Z');
  `);

  await pg.exec(await read('schema.sql'));
  const migration = (await read('migrate-from-v3.sql')).replace("'My Hospital'", "'Morris Cancer Center'");
  await pg.exec(migration);

  const dept = (await pg.query(`select d.* from oc_departments d join oc_hospitals h on h.id = d.hospital_id where h.name = 'Morris Cancer Center'`)).rows[0];
  assert.equal(dept.name, 'OR');
  assert.deepEqual(dept.groups, ['A', 'B']);
  const members = (await pg.query(`select m.full_name, m.group_name, s.name shift, m.is_manager from oc_members m left join oc_shifts s on s.id = m.shift_id order by m.full_name`)).rows;
  assert.deepEqual(members.map((m) => [m.full_name, m.group_name, m.shift, m.is_manager]), [
    ['Ayana Akbar', 'A', '7a–3p', false], ['Juan Miranda', 'B', '11a–7p', false], ['Pat Manager', null, null, true], ['Roster Only', 'B', null, false],
  ]);
  const p = (await pg.query(`select group_order, notified_count, cardinality(opens_at) n from oc_periods`)).rows[0];
  assert.deepEqual(p, { group_order: ['B', 'A'], notified_count: 1, n: 2 });
  const s = (await pg.query(`select level, block_label, hours::float h from oc_signups order by start_at`)).rows;
  assert.deepEqual(s.map((r) => [r.level, r.block_label, r.h]), [[2, '3–7 PM', 4], [1, '7–11 PM', 4]]);
  const w = (await pg.query(`select status, block_label, level, end_at is not null as has_end from oc_swaps`)).rows[0];
  assert.deepEqual(w, { status: 'pending_manager', block_label: '7–11 PM', level: 1, has_end: true });
  assert.equal((await pg.query(`select count(*)::int n from oc_profiles`)).rows[0].n, 2);

  // Running it twice is refused.
  await assert.rejects(pg.exec(migration), /Already migrated/);
});
