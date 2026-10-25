// Starting points for a new department. Everything can be changed afterwards on Manage → Settings.
import { db, must } from './lib.mjs';

export const TEMPLATES = {
  or_call_sheet: {
    name: 'OR call sheet (6-week periods, Groups A/B)',
    description: '3–7 PM first and second call for 7a–3p staff; 7–11 PM first call for 11a–7p staff, vacancies go to 7a–3p staff. 24 hours per 6 weeks. Mon–Sat.',
    settings: { use_periods: true, period_weeks: 6, min_hours: 24, groups: ['A', 'B'], group_gap_days: 1, signup_open_time: '08:00', signup_close_days: 0, switch_needs_approval: true },
    shifts: ['7a–3p', '11a–7p'],
    blocks: [
      { label: '3–7 PM', start_time: '15:00', end_time: '19:00', days: [1, 2, 3, 4, 5, 6], levels: 2, rules: { '7a–3p': 'signup' } },
      { label: '7–11 PM', start_time: '19:00', end_time: '23:00', days: [1, 2, 3, 4, 5, 6], levels: 1, rules: { '11a–7p': 'signup', '7a–3p': 'after_close' } },
    ],
  },
  weekend_24h: {
    name: '24-hour weekend call (4-week periods)',
    description: 'Saturday and Sunday 7 AM – 7 AM next day, first and second call, everyone signs up at once. 24 hours per 4 weeks.',
    settings: { use_periods: true, period_weeks: 4, min_hours: 24, groups: [], group_gap_days: 1, signup_open_time: '08:00', signup_close_days: 2, switch_needs_approval: true },
    shifts: [],
    blocks: [{ label: 'Weekend 24 h', start_time: '07:00', end_time: '07:00', days: [6, 7], levels: 2, rules: {} }],
  },
  simple_evening: {
    name: 'Simple evening call (sign up any time)',
    description: 'One evening call Mon–Fri, 5–11 PM. No periods or groups; sign up up to 8 weeks ahead.',
    settings: { use_periods: false, period_weeks: 4, min_hours: 0, groups: [], book_weeks_ahead: 8, switch_needs_approval: true },
    shifts: [],
    blocks: [{ label: 'Evening', start_time: '17:00', end_time: '23:00', days: [1, 2, 3, 4, 5], levels: 1, rules: {} }],
  },
  blank: {
    name: 'Blank (set everything yourself)',
    description: 'No call times or shifts yet. Add them on Manage → Settings.',
    settings: { use_periods: true, period_weeks: 6, min_hours: 0, groups: [] },
    shifts: [],
    blocks: [],
  },
};

export const templateList = () => Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, description: t.description }));

// Create a department from a template. Returns the new department row.
export async function createDepartment({ hospitalId, name, templateId }) {
  const t = TEMPLATES[templateId] || TEMPLATES.blank;
  const dept = must(await db().from('oc_departments').insert({ hospital_id: hospitalId, name, ...t.settings }).select('*').single());
  const shiftIds = {};
  if (t.shifts.length) {
    const rows = must(await db().from('oc_shifts').insert(t.shifts.map((s, i) => ({ department_id: dept.id, name: s, sort: i + 1 }))).select('id, name'));
    for (const r of rows) shiftIds[r.name] = r.id;
  }
  if (t.blocks.length) {
    const blocks = must(await db().from('oc_blocks').insert(t.blocks.map((b, i) => ({
      department_id: dept.id, label: b.label, start_time: b.start_time, end_time: b.end_time, days: b.days, levels: b.levels, sort: i + 1,
    }))).select('id, label'));
    const rules = [];
    for (const b of t.blocks) {
      const blockId = blocks.find((x) => x.label === b.label).id;
      for (const [shiftName, access] of Object.entries(b.rules)) rules.push({ block_id: blockId, shift_id: shiftIds[shiftName], access });
    }
    if (rules.length) must(await db().from('oc_block_rules').insert(rules));
  }
  return dept;
}
