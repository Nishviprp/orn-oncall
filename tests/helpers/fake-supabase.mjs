// Test stand-in for the Supabase client: answers the same query-builder calls the app makes,
// using an in-memory PostgreSQL (PGlite) loaded with the real schema.sql.
// Supports: select (incl. count/head and many-to-one embeds like `hospital:oc_hospitals(...)`),
// insert, update, delete, upsert, eq/neq/in/gt/gte/lt/lte/is/or, order, limit, single, maybeSingle,
// rpc, auth.getUser(token) and auth.admin.getUserById(id).

const q = (id) => `"${id.replace(/"/g, '""')}"`;

// Parse "a, b, alias:table(x, y, alias2:t2(z))" into columns and embeds.
export function parseSelect(s) {
  const parts = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const cols = [];
  const embeds = [];
  for (const p of parts) {
    const m = p.match(/^(\w+):(\w+)\((.*)\)$/s);
    if (m) embeds.push({ alias: m[1], table: m[2], select: m[3] });
    else cols.push(p);
  }
  return { cols, embeds };
}

class Builder {
  constructor(client, table) {
    this.c = client;
    this.table = table;
    this.op = 'select';
    this.where = [];
    this.params = [];
    this.orders = [];
    this.lim = null;
    this.returning = null;
    this.mode = 'many';
    this.countMode = null;
    this.head = false;
  }
  p(v) {
    this.params.push(v);
    return `$${this.params.length}`;
  }
  select(cols = '*', opts = {}) {
    if (this.op === 'select') {
      this.selectCols = cols;
      this.countMode = opts.count || null;
      this.head = Boolean(opts.head);
    } else this.returning = cols;
    return this;
  }
  insert(rows) { this.op = 'insert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  upsert(rows) { this.op = 'upsert'; this.rows = Array.isArray(rows) ? rows : [rows]; return this; }
  update(patch) { this.op = 'update'; this.patch = patch; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { this.where.push(`${q(c)} = ${this.p(v)}`); return this; }
  neq(c, v) { this.where.push(`${q(c)} <> ${this.p(v)}`); return this; }
  gt(c, v) { this.where.push(`${q(c)} > ${this.p(v)}`); return this; }
  gte(c, v) { this.where.push(`${q(c)} >= ${this.p(v)}`); return this; }
  lt(c, v) { this.where.push(`${q(c)} < ${this.p(v)}`); return this; }
  lte(c, v) { this.where.push(`${q(c)} <= ${this.p(v)}`); return this; }
  in(c, vs) {
    if (!vs.length) this.where.push('false');
    else this.where.push(`${q(c)} in (${vs.map((v) => this.p(v)).join(', ')})`);
    return this;
  }
  is(c, v) { this.where.push(`${q(c)} is ${v === null ? 'null' : v ? 'true' : 'false'}`); return this; }
  // Only the simple form the app uses: "col.op.value,col.op.value"
  or(expr) {
    const parts = expr.split(',').map((x) => {
      const [col, op, ...rest] = x.split('.');
      const val = rest.join('.');
      if (op === 'is' && val === 'null') return `${q(col)} is null`;
      const ops = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
      if (!ops[op]) throw new Error('fake or(): unsupported ' + x);
      return `${q(col)} ${ops[op]} ${this.p(val)}`;
    });
    this.where.push(`(${parts.join(' or ')})`);
    return this;
  }
  order(c, opts = {}) { this.orders.push(`${q(c)} ${opts.ascending === false ? 'desc' : 'asc'}`); return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }
  then(res, rej) { return this.run().then(res, rej); }

  async run() {
    try {
      const out = await this.exec();
      return out;
    } catch (e) {
      return { data: null, error: { code: e.code, message: e.message, details: e.detail }, count: null };
    }
  }

  whereSql() { return this.where.length ? ` where ${this.where.join(' and ')}` : ''; }

  async exec() {
    const t = q(this.table);
    let rows;
    if (this.op === 'select') {
      if (this.countMode) {
        const r = await this.c.pg.query(`select count(*)::int as n from ${t}${this.whereSql()}`, this.params);
        if (this.head) return { data: null, error: null, count: r.rows[0].n };
      }
      const sql = `select * from ${t}${this.whereSql()}${this.orders.length ? ' order by ' + this.orders.join(', ') : ''}${this.lim ? ' limit ' + this.lim : ''}`;
      rows = (await this.c.pg.query(sql, this.params)).rows;
      rows = await this.c.shape(rows, this.selectCols || '*');
    } else if (this.op === 'insert' || this.op === 'upsert') {
      rows = [];
      for (const r of this.rows) {
        const keys = Object.keys(r);
        const params = keys.map((k) => this.c.toDb(r[k]));
        const vals = keys.map((_, i) => `$${i + 1}`);
        let sql = `insert into ${t} (${keys.map(q).join(', ')}) values (${vals.join(', ')})`;
        if (this.op === 'upsert') sql += ` on conflict (id) do update set ${keys.filter((k) => k !== 'id').map((k) => `${q(k)} = excluded.${q(k)}`).join(', ')}`;
        rows.push(...(await this.c.pg.query(sql + ' returning *', params)).rows);
      }
      rows = this.returning ? await this.c.shape(rows, this.returning) : null;
    } else if (this.op === 'update') {
      const keys = Object.keys(this.patch);
      const sets = keys.map((k) => `${q(k)} = ${this.p(this.c.toDb(this.patch[k]))}`);
      rows = (await this.c.pg.query(`update ${t} set ${sets.join(', ')}${this.whereSql()} returning *`, this.params)).rows;
      rows = this.returning ? await this.c.shape(rows, this.returning) : null;
    } else if (this.op === 'delete') {
      rows = (await this.c.pg.query(`delete from ${t}${this.whereSql()} returning *`, this.params)).rows;
      rows = this.returning ? await this.c.shape(rows, this.returning) : null;
    }
    if (this.mode === 'single') {
      if (!rows || rows.length !== 1) return { data: null, error: { code: 'PGRST116', message: `expected 1 row, got ${rows?.length}` }, count: null };
      return { data: rows[0], error: null, count: null };
    }
    if (this.mode === 'maybe') {
      if (rows && rows.length > 1) return { data: null, error: { code: 'PGRST116', message: 'multiple rows' }, count: null };
      return { data: rows?.[0] ?? null, error: null, count: null };
    }
    return { data: rows, error: null, count: null };
  }
}

export function fakeSupabase(pg, users) {
  const client = {
    pg,
    users, // Map token → { id, email, phone }
    toDb(v) {
      if (Array.isArray(v)) return v; // PGlite serialises arrays
      return v;
    },
    // Keep only the selected columns and attach many-to-one embeds (alias_id → table.id).
    async shape(rows, select) {
      const { cols, embeds } = parseSelect(select);
      const out = [];
      for (const r of rows) {
        const o = cols.includes('*') ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c]]));
        for (const e of embeds) {
          const fk = r[`${e.alias}_id`];
          const found = fk ? (await pg.query(`select * from ${q(e.table)} where id = $1`, [fk])).rows : [];
          o[e.alias] = found.length ? (await client.shape(found, e.select))[0] : null;
        }
        out.push(o);
      }
      return out;
    },
    from: (table) => new Builder(client, table),
    async rpc(fn, args) {
      try {
        const keys = Object.keys(args);
        const r = await pg.query(`select * from ${q(fn)}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`, keys.map((k) => args[k]));
        return { data: r.rows[0], error: null };
      } catch (e) {
        return { data: null, error: { code: e.code, message: e.message } };
      }
    },
    auth: {
      async getUser(token) {
        const u = users.get(token);
        return u ? { data: { user: u }, error: null } : { data: { user: null }, error: { message: 'bad token' } };
      },
      admin: {
        async getUserById(id) {
          const u = [...users.values()].find((x) => x.id === id);
          return { data: { user: u || null }, error: null };
        },
      },
    },
  };
  return client;
}

// PGlite type parsers so values look like what Supabase returns (ISO strings, plain dates, numbers).
const parseArray = (s, each) => {
  if (s === '{}') return [];
  return s.slice(1, -1).split(',').map((x) => each(x.replace(/^"|"$/g, '')));
};
export const SUPABASE_LIKE_PARSERS = {
  1082: (v) => v, //                                   date → 'YYYY-MM-DD'
  1083: (v) => v, //                                   time → 'HH:MM:SS'
  1184: (v) => new Date(v).toISOString(), //           timestamptz
  1185: (v) => parseArray(v, (x) => new Date(x).toISOString()), // timestamptz[]
  1700: (v) => Number(v), //                           numeric
};
