// Administration screen: organizations, hospitals, departments, administrators.
import { $, el, api, post, attempt, toast, confirmBox, btn, emptyNote, table, formDialog } from './core.js';

let data = null;
let openDepartment = () => {};
export const setOpenDepartment = (fn) => (openDepartment = fn);

export async function loadAdmin() {
  data = await attempt(() => api('admin/tree'));
  if (!data) return;
  $('#admin-add-org').hidden = !data.you.system;
  renderTree();
  renderAdmins();
}

const stateName = (code) => data.states.find((s) => s.code === code)?.name || code;
const tzLabel = (id) => data.timezones.find((t) => t.id === id)?.label || id;
const canAdminOrg = (orgId) => data.you.system || data.you.orgIds.includes(orgId);

function renderTree() {
  const box = $('#admin-tree');
  if (!data.orgs.length) {
    return box.replaceChildren(emptyNote(data.you.system ? 'No organizations yet. Start by adding one (for example, your health system).' : 'Nothing to manage yet.'));
  }
  box.replaceChildren(...data.orgs.map((o) => {
    const card = el('section', 'org-card');
    const head = el('div', 'row-between');
    head.append(el('h3', '', o.name));
    const acts = el('div', 'row-gap');
    if (o.canEdit) acts.append(btn('Rename', 'ghost', () => editOrg(o)), btn('Add hospital', 'primary', () => editHospital(null, o)));
    if (data.you.system && !o.hospitals.length) acts.append(btn('Remove', 'ghost', () => removeOrg(o)));
    head.append(acts);
    card.append(head);
    if (!o.hospitals.length) card.append(emptyNote('No hospitals yet.'));
    for (const h of o.hospitals) {
      const hb = el('div', 'hospital-card');
      const hh = el('div', 'row-between');
      const title = el('div');
      title.append(el('strong', '', h.name), el('div', 'muted small', `${h.city ? h.city + ', ' : ''}${stateName(h.state)} · ${tzLabel(h.timezone)} time`));
      const ha = el('div', 'row-gap');
      ha.append(btn('Edit', 'ghost', () => editHospital(h, o)), btn('Add department', 'primary', () => addDepartment(h)));
      if (!h.departments.length && canAdminOrg(o.id)) ha.append(btn('Remove', 'ghost', () => removeHospital(h)));
      hh.append(title, ha);
      hb.append(hh);
      if (!h.departments.length) hb.append(emptyNote('No departments yet.'));
      else {
        hb.append(table(['Department', 'Staff', 'Status', { label: '', cls: 'actions' }], h.departments.map((d) => [
          [el('strong', '', d.name), d.managers ? null : el('div', 'warn-text small', 'No manager yet')],
          `${d.staff} (${d.managers} manager${d.managers === 1 ? '' : 's'})`,
          d.active ? el('span', 'ok-text', 'Active') : el('span', 'muted', 'Turned off'),
          [btn('Open', 'primary', () => openDepartment(d.id)), btn(d.active ? 'Turn off' : 'Turn on', 'ghost', () => toggleDept(d))],
        ])));
      }
      card.append(hb);
    }
    return card;
  }));
}

function renderAdmins() {
  const box = $('#admin-admins');
  if (!data.admins.length) return box.replaceChildren(emptyNote('No admins listed.'));
  const level = { system: 'System (everything)', org: 'Organization', hospital: 'Hospital' };
  box.replaceChildren(table(['Name', 'Level', 'Contact', { label: '', cls: 'actions' }], data.admins.map((a) => [
    [el('span', '', a.fullName || '—'), a.isMe ? el('span', 'muted small', ' (you)') : null],
    [el('div', '', level[a.scope]), a.scope !== 'system' ? el('div', 'muted small', a.where) : null],
    [el('div', '', a.email || ''), el('div', 'muted', a.phone || '')],
    a.isMe ? [] : [btn('Remove', 'ghost', () => removeAdmin(a))],
  ])));
}

// ---------- dialogs ----------

export async function editOrg(o = null) {
  const r = await formDialog({
    title: o ? 'Rename organization' : 'Add an organization',
    intro: o ? null : 'An organization is a health system or company. Hospitals belong to it.',
    fields: [{ name: 'name', label: 'Organization name', value: o?.name || '', maxLength: 120, placeholder: 'e.g. Garden State Health' }],
    onSubmit: (v) => post('admin/orgs', { id: o?.id, name: v.name }),
  });
  if (r) toast('Saved.');
  loadAdmin();
}

async function editHospital(h, o) {
  const r = await formDialog({
    title: h ? `Edit ${h.name}` : `Add a hospital to ${o.name}`,
    fields: [
      { name: 'name', label: 'Hospital or facility name', value: h?.name || '', maxLength: 120 },
      { name: 'city', label: 'City (optional)', value: h?.city || '', maxLength: 80, half: true },
      {
        name: 'state', label: 'State', type: 'select', value: h?.state || '', half: true,
        options: [{ value: '', label: 'Choose…' }, ...data.states.map((s) => ({ value: s.code, label: s.name }))],
        onChange: (code, form) => {
          const st = data.states.find((s) => s.code === code);
          if (st) form.elements.timezone.value = st.timezone;
        },
      },
      {
        name: 'timezone', label: 'Time zone', type: 'select', value: h?.timezone || 'America/New_York',
        options: data.timezones.map((t) => ({ value: t.id, label: t.label })),
        hint: 'Set from the state; change it if the hospital is in a different zone. All call times, sign-up windows and reminders use it.',
      },
    ],
    onSubmit: (v) => post('admin/hospitals', { ...v, id: h?.id, orgId: o.id }),
  });
  if (r) toast(r.note || 'Saved.', r.note ? 'info' : 'ok');
  loadAdmin();
}

async function addDepartment(h) {
  const r = await formDialog({
    title: `Add a department to ${h.name}`,
    wide: true,
    fields: [
      { name: 'name', label: 'Department name', maxLength: 120, placeholder: 'e.g. OR, Cath Lab, Endoscopy, PACU' },
      { name: 'template', label: 'Start from', type: 'choice', value: 'or_call_sheet', options: data.templates.map((t) => ({ value: t.id, label: t.name, hint: t.description })) },
      { name: 'n', type: 'note', label: 'Everything can be changed afterwards on Manage → Settings.' },
      { name: 'managerName', label: 'First nurse manager: name (optional)', maxLength: 100 },
      { name: 'managerEmail', label: 'Manager email', type: 'email', half: true },
      { name: 'managerPhone', label: 'Manager mobile', type: 'tel', half: true },
    ],
    submitLabel: 'Create department',
    onSubmit: (v) => post('admin/departments', { ...v, hospitalId: h.id }),
  });
  if (r) {
    toast('Department created.');
    document.dispatchEvent(new CustomEvent('oncall:departments-changed', { detail: { open: r.id } }));
  }
  loadAdmin();
}

async function toggleDept(d) {
  if (d.active && !(await confirmBox(`Turn off ${d.name}?`, 'Staff will no longer see it or sign up. Nothing is deleted; you can turn it back on.', 'Turn off', true))) return;
  if (await attempt(() => post('admin/departments/active', { id: d.id, active: !d.active }))) toast(d.active ? 'Turned off.' : 'Turned on.');
  document.dispatchEvent(new CustomEvent('oncall:departments-changed'));
  loadAdmin();
}

async function removeHospital(h) {
  if (!(await confirmBox(`Remove ${h.name}?`, 'It has no departments.', 'Remove', true))) return;
  if (await attempt(() => post('admin/hospitals/delete', { id: h.id }))) toast('Removed.');
  loadAdmin();
}

async function removeOrg(o) {
  if (!(await confirmBox(`Remove ${o.name}?`, 'It has no hospitals.', 'Remove', true))) return;
  if (await attempt(() => post('admin/orgs/delete', { id: o.id }))) toast('Removed.');
  loadAdmin();
}

export async function addAdmin() {
  const hospitals = data.orgs.flatMap((o) => o.hospitals.map((h) => ({ value: h.id, label: `${h.name} (${o.name})` })));
  const orgs = data.orgs.filter((o) => canAdminOrg(o.id)).map((o) => ({ value: o.id, label: o.name }));
  const levels = [];
  if (data.you.system) levels.push({ value: 'system', label: 'System admin (everything)' });
  if (orgs.length) levels.push({ value: 'org', label: 'Organization admin (all its hospitals)' });
  if (hospitals.length) levels.push({ value: 'hospital', label: 'Hospital admin (all its departments)' });
  if (!levels.length) return toast('Add a hospital first.', 'error');
  const r = await formDialog({
    title: 'Add an administrator',
    intro: 'Admins can create departments and manage every department in their area. Department managers are added on each department\'s Staff list instead.',
    fields: [
      { name: 'scope', label: 'Level', type: 'select', value: levels[levels.length - 1].value, options: levels },
      { name: 'orgId', label: 'Organization', type: 'select', value: orgs[0]?.value || '', options: orgs, show: (v) => v.scope === 'org' },
      { name: 'hospitalId', label: 'Hospital', type: 'select', value: hospitals[0]?.value || '', options: hospitals, show: (v) => v.scope === 'hospital' },
      { name: 'fullName', label: 'Name', maxLength: 100 },
      { name: 'email', label: 'Email', type: 'email', half: true },
      { name: 'phone', label: 'Mobile', type: 'tel', half: true },
    ],
    submitLabel: 'Add admin',
    onSubmit: (v) => post('admin/admins', v),
  });
  if (r) toast('Admin added. They sign in with that email or phone.');
  loadAdmin();
}

async function removeAdmin(a) {
  if (!(await confirmBox('Remove this admin?', `${a.fullName || a.email || a.phone}`, 'Remove', true))) return;
  if (await attempt(() => post('admin/admins/delete', { id: a.id }))) toast('Removed.');
  loadAdmin();
}
