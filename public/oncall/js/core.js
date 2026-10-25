// Shared page helpers: elements, API calls, toasts, dialogs, forms.
export const $ = (s, root = document) => root.querySelector(s);
export const $$ = (s, root = document) => [...root.querySelectorAll(s)];

export function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}

export const state = {
  cfg: null,
  sb: null,
  me: null,
  dept: null, // current department id
  week: null,
  tab: 'board',
  sub: 'today',
  busy: false,
};

export const currentDept = () => state.me?.departments.find((d) => d.id === state.dept) || null;
export const dq = (extra = '') => `d=${encodeURIComponent(state.dept || '')}${extra}`;

export function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage unavailable */ }
  return null;
}

// ---------- API ----------

let onSignedOut = () => {};
export const setSignedOutHandler = (fn) => (onSignedOut = fn);

export async function api(path, opts = {}) {
  const { data } = await state.sb.auth.getSession();
  const headers = { 'Content-Type': 'application/json' };
  if (data.session) headers.Authorization = `Bearer ${data.session.access_token}`;
  const init = { ...opts, headers };
  if (opts.body && typeof opts.body !== 'string') init.body = JSON.stringify(opts.body);
  const r = await fetch(`/api/oncall/${path}`, init);
  let body = {};
  try { body = await r.json(); } catch { /* empty */ }
  if (r.status === 401) {
    await state.sb.auth.signOut();
    onSignedOut('Please sign in again.');
  }
  if (!r.ok) {
    const err = new Error(body.error || 'Something went wrong. Please try again.');
    err.status = r.status;
    throw err;
  }
  return body;
}

export const post = (path, body) => api(path, { method: 'POST', body });

// Run a request; show a toast on failure. Returns the result or null.
export async function attempt(fn, quiet = false) {
  try {
    return await fn();
  } catch (e) {
    if (!quiet && e.status !== 401) toast(e.message, 'error');
    return null;
  }
}

// ---------- feedback ----------

let toastTimer;
export function toast(msg, kind = 'ok') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast ' + kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), kind === 'error' ? 7000 : 5000);
}

function waitClose(d) {
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue), { once: true }));
}

export async function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
  const d = $('#confirm-dialog');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  $('#confirm-ok').classList.toggle('danger', danger);
  d.returnValue = '';
  d.showModal();
  return (await waitClose(d)) === 'ok';
}

export function setBusy(form, busy) {
  state.busy = busy;
  form?.querySelectorAll('button, input, select, textarea').forEach((b) => (b.disabled = busy));
}

// ---------- form dialog ----------
// fields: [{ name, label, type, value, options:[{value,label,hint}], hint, required, min, max, step, placeholder, show(values) }]
// types: text, email, tel, number, time, date, select, checkbox, days, textarea, choice (radio cards), note
// onSubmit(values) may throw to keep the dialog open and show the message.
const DAY_LABELS = [[1, 'Mon'], [2, 'Tue'], [3, 'Wed'], [4, 'Thu'], [5, 'Fri'], [6, 'Sat'], [7, 'Sun']];

export function formDialog({ title, intro, fields, submitLabel = 'Save', extra, onSubmit, wide }) {
  const d = $('#form-dialog');
  const form = $('#form-dialog-form');
  d.classList.toggle('wide', Boolean(wide));
  $('#form-dialog-title').textContent = title;
  $('#form-dialog-intro').textContent = intro || '';
  $('#form-dialog-intro').hidden = !intro;
  $('#form-dialog-msg').textContent = '';
  $('#form-dialog-ok').textContent = submitLabel;
  const extraBtn = $('#form-dialog-extra');
  extraBtn.hidden = !extra;
  if (extra) extraBtn.textContent = extra.label;

  const box = $('#form-dialog-fields');
  box.replaceChildren();
  const rows = [];
  for (const f of fields) {
    const wrap = el('div', 'field' + (f.type === 'checkbox' ? ' check-field' : '') + (f.half ? ' half' : ''));
    const fid = 'fd-' + f.name;
    if (f.type === 'note') {
      wrap.append(el('p', 'muted small', f.label));
    } else if (f.type === 'checkbox') {
      const lab = el('label', 'check');
      const inp = el('input');
      inp.type = 'checkbox';
      inp.id = fid;
      inp.name = f.name;
      inp.checked = Boolean(f.value);
      lab.append(inp, document.createTextNode(' ' + f.label));
      wrap.append(lab);
    } else if (f.type === 'days') {
      wrap.append(el('div', 'label', f.label));
      const g = el('div', 'days-picker');
      for (const [n, lbl] of DAY_LABELS) {
        const lab = el('label', 'day-chip');
        const inp = el('input');
        inp.type = 'checkbox';
        inp.name = f.name;
        inp.value = String(n);
        inp.checked = (f.value || []).includes(n);
        lab.append(inp, el('span', '', lbl));
        g.append(lab);
      }
      wrap.append(g);
    } else if (f.type === 'choice') {
      wrap.append(el('div', 'label', f.label));
      const g = el('div', 'choice-list');
      for (const o of f.options) {
        const lab = el('label', 'choice');
        const inp = el('input');
        inp.type = 'radio';
        inp.name = f.name;
        inp.value = o.value;
        inp.checked = o.value === f.value;
        const txt = el('div');
        txt.append(el('strong', '', o.label));
        if (o.hint) txt.append(el('div', 'muted small', o.hint));
        lab.append(inp, txt);
        g.append(lab);
      }
      wrap.append(g);
    } else {
      const lab = el('label', '', f.label);
      lab.htmlFor = fid;
      let inp;
      if (f.type === 'select') {
        inp = el('select');
        for (const o of f.options) {
          const opt = el('option', '', o.label);
          opt.value = o.value;
          inp.append(opt);
        }
        inp.value = f.value ?? '';
      } else if (f.type === 'textarea') {
        inp = el('textarea');
        inp.rows = f.rows || 4;
        inp.value = f.value ?? '';
      } else {
        inp = el('input');
        inp.type = f.type || 'text';
        inp.value = f.value ?? '';
        for (const k of ['min', 'max', 'step', 'placeholder', 'maxLength', 'autocomplete']) if (f[k] !== undefined) inp[k] = f[k];
      }
      inp.id = fid;
      inp.name = f.name;
      wrap.append(lab, inp);
    }
    if (f.hint) wrap.append(el('div', 'muted small hint', f.hint));
    box.append(wrap);
    rows.push({ f, wrap });
  }

  const values = () => {
    const v = {};
    for (const { f } of rows) {
      if (f.type === 'note') continue;
      if (f.type === 'checkbox') v[f.name] = form.elements[f.name].checked;
      else if (f.type === 'days') v[f.name] = $$(`input[name="${f.name}"]:checked`, form).map((x) => Number(x.value));
      else if (f.type === 'choice') v[f.name] = $(`input[name="${f.name}"]:checked`, form)?.value || null;
      else v[f.name] = form.elements[f.name].value.trim();
    }
    return v;
  };
  const refresh = () => {
    const v = values();
    for (const { f, wrap } of rows) if (f.show) wrap.hidden = !f.show(v);
  };
  form.oninput = refresh;
  form.onchange = (e) => {
    const f = fields.find((x) => x.name === e.target.name);
    if (f?.onChange) f.onChange(e.target.value, form);
    refresh();
  };
  refresh();

  return new Promise((resolve) => {
    const finish = (result) => {
      form.onsubmit = null;
      extraBtn.onclick = null;
      $('#form-dialog-cancel').onclick = null;
      d.close();
      resolve(result);
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const v = values();
      $('#form-dialog-msg').textContent = '';
      setBusy(form, true);
      try {
        const r = onSubmit ? await onSubmit(v) : v;
        setBusy(form, false);
        finish(r ?? v);
      } catch (err) {
        setBusy(form, false);
        $('#form-dialog-msg').textContent = err.message;
      }
    };
    extraBtn.onclick = async () => {
      try {
        const r = await extra.onClick(values());
        if (r !== false) finish({ extra: true, result: r });
      } catch (err) {
        $('#form-dialog-msg').textContent = err.message;
      }
    };
    $('#form-dialog-cancel').onclick = () => finish(null);
    d.addEventListener('cancel', () => resolve(null), { once: true });
    d.showModal();
    const first = box.querySelector('input:not([type=checkbox]):not([type=radio]), select, textarea');
    first?.focus();
  });
}

// ---------- formatting ----------

export function normalizePhone(v) {
  const raw = String(v || '').trim();
  const d = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && d.length >= 8 && d.length <= 15) return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  return null;
}

export function prettyPhone(p) {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('1')) return `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
}

export const validEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export const btn = (label, cls, fn, title) => {
  const b = el('button', 'btn small ' + cls, label);
  b.type = 'button';
  if (title) b.title = title;
  b.addEventListener('click', fn);
  return b;
};

export const emptyNote = (t) => el('p', 'muted', t);

// Give each cell its column name, so tables stack as cards on phones.
export function labelCells(table) {
  const heads = $$('thead th', table).map((th) => th.textContent);
  $$('tbody tr', table).forEach((tr) => [...tr.children].forEach((td, i) => { if (heads[i]) td.dataset.label = heads[i]; }));
  return table;
}

// Build a table from headers and rows of cells (strings or elements).
export function table(headers, rows, cls = 'calls') {
  const t = el('table', cls);
  const thead = el('thead');
  const hr = el('tr');
  headers.forEach((h) => hr.append(el('th', h.cls || '', h.label ?? h)));
  thead.append(hr);
  const tbody = el('tbody');
  for (const r of rows) {
    const tr = el('tr');
    r.forEach((c, i) => {
      const td = el('td', headers[i]?.cls || '');
      if (c instanceof Node) td.append(c);
      else if (Array.isArray(c)) td.append(...c.filter(Boolean));
      else td.textContent = c ?? '';
      tr.append(td);
    });
    tbody.append(tr);
  }
  t.append(thead, tbody);
  return labelCells(t);
}

export function printWith(cls, subtitle) {
  $('#print-sub').textContent = subtitle;
  document.body.classList.add(cls);
  const done = () => document.body.classList.remove(cls);
  window.addEventListener('afterprint', done, { once: true });
  window.print();
  setTimeout(done, 1000);
}

export const printedAt = () => new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

export function sentBy(sent) {
  const ways = [sent?.email === 'sent' && 'email', sent?.sms === 'sent' && 'text'].filter(Boolean);
  return ways.length ? ` Sent by ${ways.join(' and ')}.` : '';
}
