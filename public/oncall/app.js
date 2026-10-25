// ORN Global – ON CALL page: sign-in, department picker, tabs, account.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import {
  $, $$, el, state, api, post, attempt, toast, setBusy, store, currentDept, setSignedOutHandler, normalizePhone, prettyPhone, validEmail,
} from './js/core.js';
import { loadBoard, loadMine, loadSwitches, renderBadge, printBoard, printMine } from './js/staff.js';
import {
  switchSub, loadToday, onPeriodSubmit, periodPreview, loadHours, printHours, editStaff, importStaff, editBlock, editShift, saveRules,
} from './js/manage.js';
import { loadAdmin, editOrg, addAdmin, setOpenDepartment } from './js/admin.js';

const TABS = ['board', 'mine', 'switches', 'manage', 'admin', 'account'];
const HASH = { board: '', mine: '#my-calls', switches: '#switches', manage: '#manage', admin: '#admin', account: '#account' };

function show(id) {
  for (const v of ['view-loading', 'view-fatal', 'view-login', 'view-app']) $('#' + v).hidden = v !== id;
}

async function init() {
  try {
    const r = await fetch('/api/oncall/config');
    const cfg = await r.json();
    if (!r.ok) throw new Error(cfg.error);
    state.cfg = cfg;
  } catch (e) {
    $('#fatal-msg').textContent = e.message || 'Please try again later.';
    show('view-fatal');
    return;
  }
  state.sb = createClient(state.cfg.supabaseUrl, state.cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
  setSignedOutHandler(showLogin);
  if (!state.cfg.phoneLogin) $('#mode-phone').hidden = true;
  wireEvents();

  const { data } = await state.sb.auth.getSession();
  if (data.session) await enterApp();
  else showLogin();
  state.sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') showLogin(); });

  setInterval(() => {
    if ($('#view-app').hidden || document.visibilityState !== 'visible' || state.busy || document.querySelector('dialog[open]')) return;
    if (state.tab === 'board') loadBoard(state.week, true);
    if (state.tab === 'switches') loadSwitches();
    if (state.tab === 'manage' && state.sub === 'today') loadToday();
  }, 60000);
}

// ---------- sign in ----------

let loginMode = 'email';
let pending = null;

function setLoginMode(mode) {
  loginMode = mode;
  for (const m of ['email', 'phone']) {
    $('#mode-' + m).classList.toggle('active', m === mode);
    $('#mode-' + m).setAttribute('aria-selected', m === mode);
  }
  const input = $('#login-value');
  input.value = '';
  Object.assign(input, mode === 'email'
    ? { type: 'email', autocomplete: 'email', inputMode: 'email', placeholder: 'you@example.com' }
    : { type: 'tel', autocomplete: 'tel', inputMode: 'tel', placeholder: '(732) 555-1234' });
  $('#login-label').textContent = mode === 'email' ? 'Email address' : 'Mobile number';
  $('#login-msg').textContent = '';
}

function showLogin(msg = '') {
  state.me = null;
  $('#login-form').hidden = false;
  $('#code-form').hidden = true;
  $('#login-msg').textContent = msg;
  show('view-login');
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const raw = $('#login-value').value.trim();
  $('#login-msg').textContent = '';
  const value = loginMode === 'email' ? raw.toLowerCase() : normalizePhone(raw);
  if (loginMode === 'email' ? !validEmail(value) : !value) {
    $('#login-msg').textContent = loginMode === 'email' ? 'Please enter a valid email address.' : 'Please enter a valid mobile number.';
    return;
  }
  setBusy(form, true);
  const { error } = loginMode === 'email'
    ? await state.sb.auth.signInWithOtp({ email: value, options: { shouldCreateUser: true } })
    : await state.sb.auth.signInWithOtp({ phone: value });
  setBusy(form, false);
  if (error) return ($('#login-msg').textContent = error.message);
  pending = { mode: loginMode, value };
  $('#code-sent').textContent = `We sent a code to ${loginMode === 'email' ? value : prettyPhone(value)}. It expires soon.`;
  $('#login-form').hidden = true;
  $('#code-form').hidden = false;
  $('#code-value').value = '';
  $('#code-value').focus();
}

async function onCodeSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const token = $('#code-value').value.replace(/\D/g, '');
  if (token.length < 6) return ($('#login-msg').textContent = 'Please enter the code from your message.');
  setBusy(form, true);
  const { error } = pending.mode === 'email'
    ? await state.sb.auth.verifyOtp({ email: pending.value, token, type: 'email' })
    : await state.sb.auth.verifyOtp({ phone: pending.value, token, type: 'sms' });
  setBusy(form, false);
  if (error) return ($('#login-msg').textContent = 'That code did not work. Check it, or request a new one.');
  $('#login-msg').textContent = '';
  await enterApp();
}

// ---------- app shell ----------

async function refreshMe() {
  const me = await attempt(() => api('me'));
  if (!me) return false;
  state.me = me;
  const ids = me.departments.map((d) => d.id);
  const fromUrl = new URLSearchParams(location.search).get('d');
  const saved = store('oncall.dept');
  state.dept = [state.dept, fromUrl, saved].find((x) => x && ids.includes(x)) || ids[0] || null;
  renderPicker();
  renderAccount();
  renderBadge(me.pendingSwitches || 0);
  return true;
}

async function enterApp() {
  show('view-app');
  if (!(await refreshMe())) return;
  const fromHash = Object.entries(HASH).find(([, h]) => h && h === location.hash)?.[0];
  if (!state.me.fullName) switchTab('account');
  else if (fromHash && tabAllowed(fromHash)) switchTab(fromHash);
  else if (!state.dept && state.me.admin.any) switchTab('admin');
  else switchTab('board');
}

function renderPicker() {
  const sel = $('#dept-picker');
  const list = state.me.departments;
  $('#dept-picker-wrap').hidden = list.length < 2;
  const byHospital = {};
  for (const d of list) (byHospital[`${d.hospitalName}${d.state ? ' · ' + d.state : ''}`] ||= []).push(d);
  sel.replaceChildren(...Object.entries(byHospital).map(([h, ds]) => {
    const g = el('optgroup');
    g.label = h;
    for (const d of ds) {
      const o = el('option', '', `${d.name}${d.active ? '' : ' (turned off)'}${d.member ? '' : ' · manage only'}`);
      o.value = d.id;
      g.append(o);
    }
    return g;
  }));
  sel.value = state.dept || '';
  const d = currentDept();
  $('#dept-title').textContent = d ? `${d.name} · ${d.hospitalName}` : '';
  $('#tab-manage').hidden = !d?.canManage;
  $('#tab-admin').hidden = !state.me.admin.any;
  for (const t of ['board', 'mine', 'switches']) $(`.tab[data-tab=${t}]`).hidden = !list.length;
}

function setDept(id, tab) {
  state.dept = id;
  state.week = null;
  store('oncall.dept', id);
  const url = new URL(location.href);
  url.searchParams.set('d', id);
  history.replaceState(null, '', url.pathname + url.search + location.hash);
  renderPicker();
  switchTab(tab && tabAllowed(tab) ? tab : tabAllowed(state.tab) ? state.tab : 'board');
}

function tabAllowed(tab) {
  const d = currentDept();
  if (tab === 'manage') return Boolean(d?.canManage);
  if (tab === 'admin') return Boolean(state.me?.admin.any);
  if (['board', 'mine', 'switches'].includes(tab)) return Boolean(state.me?.departments.length);
  return true;
}

function renderNotice() {
  const n = $('#notice');
  const me = state.me;
  const d = currentDept();
  let msg = '';
  if (me && !me.fullName) msg = 'Welcome! Add your full name below to get started.';
  else if (me && !me.departments.length && !me.admin.any) msg = "You're not on any department's staff list yet. Ask your nurse manager to add your email or mobile number.";
  else if (d && !d.member && state.tab === 'board') msg = "You manage this department but aren't on its staff list, so you can view the schedule but not sign up.";
  else if (me && (!me.contact.email || !me.contact.phone) && state.tab === 'account') msg = 'Tip: add both your email and mobile number so you get messages both ways.';
  n.textContent = msg;
  n.hidden = !msg;
  $('#hello').textContent = me?.fullName ? `Signed in as ${me.fullName}` : '';
}

function switchTab(tab) {
  if (!tabAllowed(tab)) tab = state.me?.departments.length ? 'board' : state.me?.admin.any ? 'admin' : 'account';
  state.tab = tab;
  $$('.tab').forEach((t) => {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  });
  for (const t of TABS) $('#panel-' + t).hidden = t !== tab;
  renderNotice();
  if (location.hash !== HASH[tab]) history.replaceState(null, '', location.pathname + location.search + HASH[tab]);
  if (tab === 'board') loadBoard(state.week);
  if (tab === 'mine') loadMine();
  if (tab === 'switches') loadSwitches();
  if (tab === 'manage') switchSub(state.sub || 'today');
  if (tab === 'admin') loadAdmin();
}

// ---------- account ----------

function renderAccount() {
  const me = state.me;
  $('#full-name').value = me.fullName || '';
  $('#email-value').textContent = me.contact.email || 'Not added';
  $('#phone-value').textContent = me.contact.phone ? prettyPhone(me.contact.phone) : 'Not added';
  $('#phone-change').hidden = !state.cfg.phoneLogin;
  $('#my-departments').replaceChildren(...(me.departments.length
    ? me.departments.map((d) => el('li', '', `${d.name} · ${d.hospitalName}${d.state ? ', ' + d.state : ''}${d.canManage ? ' (manager)' : ''}${d.member ? '' : ' – manage only'}`))
    : [el('li', 'muted', 'None yet.')]));
  const roles = [];
  if (me.admin.system) roles.push('System admin');
  if (me.admin.orgIds.length) roles.push('Organization admin');
  if (me.admin.hospitalIds.length) roles.push('Hospital admin');
  $('#admin-roles').textContent = roles.length ? `Admin access: ${roles.join(', ')}.` : '';
}

async function onNameSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const full_name = $('#full-name').value.trim();
  if (full_name.length < 2) return toast('Please enter your full name.', 'error');
  setBusy(form, true);
  if (await attempt(() => post('me', { full_name }))) {
    await refreshMe();
    toast('Name saved.');
    renderNotice();
  }
  setBusy(form, false);
}

let pendingEmail = null;
let pendingPhone = null;

async function onEmailSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const email = $('#email-new').value.trim().toLowerCase();
  if (!validEmail(email)) return toast('Please enter a valid email address.', 'error');
  setBusy(form, true);
  const { error } = await state.sb.auth.updateUser({ email });
  setBusy(form, false);
  if (error) return toast(error.message, 'error');
  pendingEmail = email;
  $('#email-form').hidden = true;
  $('#email-code-form').hidden = false;
  $('#email-code').focus();
  toast(`We sent a code to ${email}.`);
}

async function onEmailCode(e) {
  e.preventDefault();
  const form = e.currentTarget;
  setBusy(form, true);
  const { error } = await state.sb.auth.verifyOtp({ email: pendingEmail, token: $('#email-code').value.replace(/\D/g, ''), type: 'email_change' });
  setBusy(form, false);
  if (error) return toast('That code did not work. Please try again.', 'error');
  $('#email-code-form').hidden = true;
  await state.sb.auth.refreshSession();
  await refreshMe();
  toast('Email verified.');
}

async function onPhoneSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const phone = normalizePhone($('#phone-new').value);
  if (!phone) return toast('Please enter a valid mobile number.', 'error');
  setBusy(form, true);
  const { error } = await state.sb.auth.updateUser({ phone });
  setBusy(form, false);
  if (error) return toast(error.message, 'error');
  pendingPhone = phone;
  $('#phone-form').hidden = true;
  $('#phone-code-form').hidden = false;
  $('#phone-code').focus();
  toast(`We texted a code to ${prettyPhone(phone)}.`);
}

async function onPhoneCode(e) {
  e.preventDefault();
  const form = e.currentTarget;
  setBusy(form, true);
  const { error } = await state.sb.auth.verifyOtp({ phone: pendingPhone, token: $('#phone-code').value.replace(/\D/g, ''), type: 'phone_change' });
  setBusy(form, false);
  if (error) return toast('That code did not work. Please try again.', 'error');
  $('#phone-code-form').hidden = true;
  await state.sb.auth.refreshSession();
  await refreshMe();
  toast('Mobile number verified.');
}

// ---------- events ----------

function wireEvents() {
  $('#mode-email').addEventListener('click', () => setLoginMode('email'));
  $('#mode-phone').addEventListener('click', () => setLoginMode('phone'));
  $('#login-form').addEventListener('submit', onLoginSubmit);
  $('#code-form').addEventListener('submit', onCodeSubmit);
  $('#code-back').addEventListener('click', () => showLogin());
  $('#sign-out').addEventListener('click', async () => {
    await state.sb.auth.signOut();
    showLogin();
  });

  $$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));
  $('#dept-picker').addEventListener('change', (e) => setDept(e.target.value));
  setOpenDepartment(async (id) => {
    await refreshMe();
    setDept(id, 'manage');
  });
  document.addEventListener('oncall:departments-changed', async (e) => {
    await refreshMe();
    if (e.detail?.open) setDept(e.detail.open, 'manage');
  });
  document.addEventListener('oncall:dept-changed', () => refreshMe());

  // Board and my calls
  $('#prev-week').addEventListener('click', (e) => e.currentTarget.dataset.week && loadBoard(e.currentTarget.dataset.week));
  $('#next-week').addEventListener('click', (e) => e.currentTarget.dataset.week && loadBoard(e.currentTarget.dataset.week));
  $('#print-board').addEventListener('click', printBoard);
  $('#print-mine').addEventListener('click', printMine);

  // Manage
  $$('.sub-tabs .seg').forEach((b) => b.addEventListener('click', () => switchSub(b.dataset.sub)));
  $('#today-date').addEventListener('change', loadToday);
  $('#period-form').addEventListener('submit', onPeriodSubmit);
  ['#p-start', '#p-signup', '#p-order'].forEach((id) => $(id).addEventListener('input', periodPreview));
  $('#hours-period').addEventListener('change', (e) => loadHours({ period: e.target.value }));
  $('#hours-range').addEventListener('change', () => loadHours({ from: $('#hours-from').value, to: $('#hours-to').value }));
  $('#print-hours').addEventListener('click', printHours);
  $('#staff-add').addEventListener('click', () => editStaff(null));
  $('#staff-import').addEventListener('click', importStaff);
  $('#block-add').addEventListener('click', () => editBlock(null));
  $('#shift-add').addEventListener('click', () => editShift(null));
  $('#rules-save').addEventListener('click', saveRules);

  // Admin
  $('#admin-add-org').addEventListener('click', () => editOrg(null));
  $('#admin-add-admin').addEventListener('click', addAdmin);

  // Account
  $('#name-form').addEventListener('submit', onNameSubmit);
  $('#email-change').addEventListener('click', () => {
    $('#email-form').hidden = !$('#email-form').hidden;
    $('#email-code-form').hidden = true;
  });
  $('#phone-change').addEventListener('click', () => {
    $('#phone-form').hidden = !$('#phone-form').hidden;
    $('#phone-code-form').hidden = true;
  });
  $('#email-form').addEventListener('submit', onEmailSubmit);
  $('#email-code-form').addEventListener('submit', onEmailCode);
  $('#phone-form').addEventListener('submit', onPhoneSubmit);
  $('#phone-code-form').addEventListener('submit', onPhoneCode);
}

init();
