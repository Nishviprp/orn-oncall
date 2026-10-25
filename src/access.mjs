// Who is this user, and what may they see and change?
//   staff        – on a department's staff list (matched by email or phone)
//   manager      – staff row with is_manager in that department
//   hospital/org admin – manages every department in that hospital / organization
//   system admin – manages everything
import { db, must, HttpError, contactFor, requireUser, matchesContact } from './lib.mjs';

async function rowsByContact(table, select, contact) {
  const out = [];
  if (contact.email) out.push(...must(await db().from(table).select(select).eq('email', contact.email)));
  if (contact.phone) out.push(...must(await db().from(table).select(select).eq('phone', contact.phone)));
  const seen = new Set();
  return out.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
}

// Several rows for one person in one department (one by email, one by phone) are merged.
export function mergeMembers(rows) {
  const byDept = {};
  for (const r of rows) {
    const m = (byDept[r.department_id] ||= { department_id: r.department_id, ids: [], is_manager: false, group_name: null, shift_id: null, full_name: r.full_name });
    m.ids.push(r.id);
    m.is_manager ||= r.is_manager;
    m.group_name ||= r.group_name;
    m.shift_id ||= r.shift_id;
  }
  return byDept;
}

export async function getAccess(req) {
  const user = await requireUser(req);
  const contact = contactFor(user);
  const [memberRows, adminRows] = await Promise.all([
    rowsByContact('oc_members', '*', contact),
    rowsByContact('oc_admins', '*', contact),
  ]);
  return buildAccess(user, contact, memberRows, adminRows);
}

export function buildAccess(user, contact, memberRows, adminRows) {
  const members = mergeMembers(memberRows.filter((r) => matchesContact(r, contact)));
  const admins = adminRows.filter((r) => matchesContact(r, contact));
  return {
    user,
    contact,
    members,
    admins,
    system: admins.some((a) => a.scope === 'system'),
    orgIds: admins.filter((a) => a.scope === 'org').map((a) => a.org_id),
    hospitalIds: admins.filter((a) => a.scope === 'hospital').map((a) => a.hospital_id),
  };
}

export const isAnyAdmin = (a) => a.system || a.orgIds.length > 0 || a.hospitalIds.length > 0;

// Admin over a hospital (or the org it belongs to)?
export const adminOfHospital = (a, hospitalId, orgId) => a.system || a.orgIds.includes(orgId) || a.hospitalIds.includes(hospitalId);
export const adminOfOrg = (a, orgId) => a.system || a.orgIds.includes(orgId);

export const memberOf = (a, deptId) => a.members[deptId] || null;

export function canManage(a, cfg) {
  return Boolean(memberOf(a, cfg.id)?.is_manager || adminOfHospital(a, cfg.hospital.id, cfg.org.id));
}

export function requireManage(a, cfg) {
  if (!canManage(a, cfg)) throw new HttpError(403, 'Only a manager of this department can do this.');
}

export function requireSeeDept(a, cfg) {
  if (!memberOf(a, cfg.id) && !canManage(a, cfg)) throw new HttpError(403, "You don't have access to this department.");
}

// Every department this person belongs to or manages, with names for the picker.
export async function visibleDepartments(a) {
  const rows = must(await db().from('oc_departments')
    .select('id, name, active, hospital_id, hospital:oc_hospitals(id, name, state, org_id, org:oc_orgs(id, name))')
    .order('name'));
  return rows
    .map((d) => {
      const member = a.members[d.id] || null;
      const manage = Boolean(member?.is_manager || adminOfHospital(a, d.hospital_id, d.hospital?.org_id));
      return { d, member, manage };
    })
    .filter(({ d, member, manage }) => manage || (member && d.active))
    .map(({ d, member, manage }) => ({
      id: d.id,
      name: d.name,
      active: d.active,
      hospitalId: d.hospital_id,
      hospitalName: d.hospital?.name || '',
      state: d.hospital?.state || '',
      orgName: d.hospital?.org?.name || '',
      member: Boolean(member),
      canManage: manage,
    }))
    .sort((x, y) => (x.member === y.member ? `${x.hospitalName} ${x.name}`.localeCompare(`${y.hospitalName} ${y.name}`) : x.member ? -1 : 1));
}

export async function managedDeptIds(a) {
  return (await visibleDepartments(a)).filter((d) => d.canManage).map((d) => d.id);
}
