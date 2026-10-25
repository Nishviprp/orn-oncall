// Administration: organizations, hospitals, departments and administrators.
//   system admin  – everything
//   org admin     – hospitals and departments in their organization; can add org/hospital admins there
//   hospital admin – departments in their hospital; can add hospital admins there
import {
  HttpError, json, readJson, db, must, needUuid, cleanText, normEmail, normPhone, matchesContact, US_STATES, TIME_ZONES,
} from './lib.mjs';
import { getAccess, adminOfHospital, adminOfOrg, isAnyAdmin } from './access.mjs';
import { templateList, createDepartment, TEMPLATES } from './templates.mjs';

async function adminCtx(req) {
  const a = await getAccess(req);
  if (!isAnyAdmin(a)) throw new HttpError(403, 'Only administrators can do this.');
  return a;
}

async function hospitalRow(id) {
  const h = must(await db().from('oc_hospitals').select('*').eq('id', id).maybeSingle());
  if (!h) throw new HttpError(404, 'Hospital not found.');
  return h;
}

// Can this admin manage admins at that scope?
function canGrant(a, scope, orgId, hospital) {
  if (a.system) return true;
  if (scope === 'system') return false;
  if (scope === 'org') return a.orgIds.includes(orgId);
  if (scope === 'hospital') return adminOfHospital(a, hospital.id, hospital.org_id);
  return false;
}

async function tree(req) {
  const a = await adminCtx(req);
  const [orgs, hospitals, depts, admins, members] = await Promise.all([
    db().from('oc_orgs').select('*').order('name'),
    db().from('oc_hospitals').select('*').order('name'),
    db().from('oc_departments').select('id, name, active, hospital_id').order('name'),
    db().from('oc_admins').select('*').order('full_name'),
    db().from('oc_members').select('department_id, is_manager'),
  ]);
  const hs = must(hospitals).filter((h) => adminOfHospital(a, h.id, h.org_id));
  const visibleOrgIds = new Set([...hs.map((h) => h.org_id), ...a.orgIds]);
  const os = must(orgs).filter((o) => a.system || visibleOrgIds.has(o.id));
  const staffCount = {};
  const managerCount = {};
  for (const m of must(members)) {
    staffCount[m.department_id] = (staffCount[m.department_id] || 0) + 1;
    if (m.is_manager) managerCount[m.department_id] = (managerCount[m.department_id] || 0) + 1;
  }
  const hospById = Object.fromEntries(must(hospitals).map((h) => [h.id, h]));
  const visibleAdmins = must(admins).filter((r) => {
    if (r.scope === 'system') return a.system;
    if (r.scope === 'org') return adminOfOrg(a, r.org_id);
    const h = hospById[r.hospital_id];
    return h && adminOfHospital(a, h.id, h.org_id);
  });
  return json(200, {
    you: { system: a.system, orgIds: a.orgIds, hospitalIds: a.hospitalIds },
    states: Object.entries(US_STATES).map(([code, [name, tz]]) => ({ code, name, timezone: tz })),
    timezones: Object.entries(TIME_ZONES).map(([id, label]) => ({ id, label })),
    templates: templateList(),
    orgs: os.map((o) => ({
      id: o.id,
      name: o.name,
      canEdit: adminOfOrg(a, o.id),
      hospitals: hs.filter((h) => h.org_id === o.id).map((h) => ({
        id: h.id, name: h.name, state: h.state, city: h.city, timezone: h.timezone,
        departments: must(depts).filter((d) => d.hospital_id === h.id).map((d) => ({
          id: d.id, name: d.name, active: d.active, staff: staffCount[d.id] || 0, managers: managerCount[d.id] || 0,
        })),
      })),
    })),
    admins: visibleAdmins.map((r) => ({
      id: r.id, scope: r.scope, orgId: r.org_id, hospitalId: r.hospital_id,
      where: r.scope === 'system' ? 'All organizations' : r.scope === 'org' ? (must(orgs).find((o) => o.id === r.org_id)?.name || '') : (hospById[r.hospital_id]?.name || ''),
      fullName: r.full_name, email: r.email, phone: r.phone, isMe: matchesContact(r, a.contact),
    })),
  });
}

async function orgSave(req) {
  const a = await adminCtx(req);
  const b = await readJson(req);
  const name = cleanText(b.name, 120);
  if (!name || name.length < 2) throw new HttpError(400, 'Please enter the organization name.');
  if (b.id) {
    const id = needUuid(b.id, 'organization');
    if (!adminOfOrg(a, id)) throw new HttpError(403, 'Only an admin of this organization can rename it.');
    must(await db().from('oc_orgs').update({ name }).eq('id', id));
    return json(200, { id });
  }
  if (!a.system) throw new HttpError(403, 'Only a system admin can add organizations.');
  return json(200, { id: must(await db().from('oc_orgs').insert({ name }).select('id').single()).id });
}

function hospitalFields(b) {
  const name = cleanText(b.name, 120);
  if (!name || name.length < 2) throw new HttpError(400, 'Please enter the hospital name.');
  const state = String(b.state || '').toUpperCase();
  if (!US_STATES[state]) throw new HttpError(400, 'Choose the state.');
  const timezone = b.timezone || US_STATES[state][1];
  if (!TIME_ZONES[timezone]) throw new HttpError(400, 'Choose the time zone.');
  return { name, state, city: cleanText(b.city, 80), timezone };
}

async function hospitalSave(req) {
  const a = await adminCtx(req);
  const b = await readJson(req);
  const fields = hospitalFields(b);
  if (b.id) {
    const h = await hospitalRow(needUuid(b.id, 'hospital'));
    if (!adminOfHospital(a, h.id, h.org_id)) throw new HttpError(403, 'You are not an admin of this hospital.');
    must(await db().from('oc_hospitals').update(fields).eq('id', h.id));
    return json(200, { id: h.id, note: h.timezone !== fields.timezone ? 'Time zone changed. Existing sign-ups keep their times; new sign-ups, periods and reminders use the new time zone.' : null });
  }
  const orgId = needUuid(b.orgId, 'organization');
  if (!adminOfOrg(a, orgId)) throw new HttpError(403, 'Only an admin of this organization can add hospitals.');
  return json(200, { id: must(await db().from('oc_hospitals').insert({ ...fields, org_id: orgId }).select('id').single()).id });
}

async function departmentCreate(req) {
  const a = await adminCtx(req);
  const b = await readJson(req);
  const h = await hospitalRow(needUuid(b.hospitalId, 'hospital'));
  if (!adminOfHospital(a, h.id, h.org_id)) throw new HttpError(403, 'You are not an admin of this hospital.');
  const name = cleanText(b.name, 120);
  if (!name || name.length < 2) throw new HttpError(400, 'Please enter the department name.');
  if (b.template && !TEMPLATES[b.template]) throw new HttpError(400, 'Unknown template.');

  let manager = null;
  if (b.managerName || b.managerEmail || b.managerPhone) {
    manager = { full_name: cleanText(b.managerName, 100), email: normEmail(b.managerEmail), phone: normPhone(b.managerPhone), is_manager: true };
    if (!manager.full_name || manager.full_name.length < 2) throw new HttpError(400, "Enter the manager's name.");
    if (!manager.email && !manager.phone) throw new HttpError(400, "Enter the manager's email or mobile number.");
  }
  const dept = await createDepartment({ hospitalId: h.id, name, templateId: b.template || 'blank' });
  if (manager) must(await db().from('oc_members').insert({ ...manager, department_id: dept.id }));
  return json(200, { id: dept.id });
}

async function departmentActive(req) {
  const a = await adminCtx(req);
  const b = await readJson(req);
  const d = must(await db().from('oc_departments').select('id, hospital_id').eq('id', needUuid(b.id, 'department')).maybeSingle());
  if (!d) throw new HttpError(404, 'Department not found.');
  const h = await hospitalRow(d.hospital_id);
  if (!adminOfHospital(a, h.id, h.org_id)) throw new HttpError(403, 'You are not an admin of this hospital.');
  must(await db().from('oc_departments').update({ active: Boolean(b.active) }).eq('id', d.id));
  return json(200, { active: Boolean(b.active) });
}

async function hospitalDelete(req) {
  const a = await adminCtx(req);
  const h = await hospitalRow(needUuid((await readJson(req)).id, 'hospital'));
  if (!adminOfOrg(a, h.org_id)) throw new HttpError(403, 'Only an organization admin can remove a hospital.');
  const { count } = await db().from('oc_departments').select('id', { count: 'exact', head: true }).eq('hospital_id', h.id);
  if (count) throw new HttpError(409, 'Remove or move its departments first. (Departments can be turned off instead.)');
  must(await db().from('oc_hospitals').delete().eq('id', h.id));
  return json(200, { deleted: true });
}

async function orgDelete(req) {
  const a = await adminCtx(req);
  if (!a.system) throw new HttpError(403, 'Only a system admin can remove an organization.');
  const id = needUuid((await readJson(req)).id, 'organization');
  const { count } = await db().from('oc_hospitals').select('id', { count: 'exact', head: true }).eq('org_id', id);
  if (count) throw new HttpError(409, 'Remove its hospitals first.');
  must(await db().from('oc_orgs').delete().eq('id', id));
  return json(200, { deleted: true });
}

async function adminSave(req) {
  const a = await adminCtx(req);
  const b = await readJson(req);
  const scope = b.scope;
  if (!['system', 'org', 'hospital'].includes(scope)) throw new HttpError(400, 'Choose the admin level.');
  const row = {
    scope,
    org_id: scope === 'org' ? needUuid(b.orgId, 'organization') : null,
    hospital_id: scope === 'hospital' ? needUuid(b.hospitalId, 'hospital') : null,
    full_name: cleanText(b.fullName, 100),
    email: normEmail(b.email),
    phone: normPhone(b.phone),
  };
  if (!row.full_name) throw new HttpError(400, 'Enter their name.');
  if (!row.email && !row.phone) throw new HttpError(400, 'Enter an email or mobile number so they can sign in.');
  const hospital = row.hospital_id ? await hospitalRow(row.hospital_id) : null;
  if (!canGrant(a, scope, row.org_id, hospital)) throw new HttpError(403, "You can't add an admin at that level.");
  return json(200, { id: must(await db().from('oc_admins').insert(row).select('id').single()).id });
}

async function adminDelete(req) {
  const a = await adminCtx(req);
  const id = needUuid((await readJson(req)).id, 'admin');
  const r = must(await db().from('oc_admins').select('*').eq('id', id).maybeSingle());
  if (!r) throw new HttpError(404, 'Admin not found.');
  if (matchesContact(r, a.contact)) throw new HttpError(400, "You can't remove your own admin access. Ask another admin.");
  const hospital = r.hospital_id ? await hospitalRow(r.hospital_id) : null;
  if (!canGrant(a, r.scope, r.org_id, hospital)) throw new HttpError(403, "You can't remove this admin.");
  must(await db().from('oc_admins').delete().eq('id', id));
  return json(200, { deleted: true });
}

export const ADMIN_ROUTES = {
  'GET /api/oncall/admin/tree': tree,
  'POST /api/oncall/admin/orgs': orgSave,
  'POST /api/oncall/admin/orgs/delete': orgDelete,
  'POST /api/oncall/admin/hospitals': hospitalSave,
  'POST /api/oncall/admin/hospitals/delete': hospitalDelete,
  'POST /api/oncall/admin/departments': departmentCreate,
  'POST /api/oncall/admin/departments/active': departmentActive,
  'POST /api/oncall/admin/admins': adminSave,
  'POST /api/oncall/admin/admins/delete': adminDelete,
};
