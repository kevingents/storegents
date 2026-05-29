/**
 * lib/taken-store.js
 *
 * Terugkerende taken ("takenplanner"). Een TAAK is een sjabloon met een
 * herhaling (dagelijks / wekelijks / maandelijks) en een toewijzing aan een
 * persoon of een groep. Op de vervaldag genereert de cron een TAAK-INSTANTIE
 * (een concreet "te doen vandaag"-item) die de toegewezene afvinkt.
 *
 * Voorbeelden:
 *   - Rick (Supplychain) — elke maandag: "Controleer of de voorraad klopt".
 *   - Fosse (Marketing) — elke week: "Check de voorraad van foto's".
 *
 * Blob: admin/taken.json = { tasks: { [id]: {...} }, instances: { [id]: {...} }, updatedAt }
 *
 * Taak:
 *   { id, title, description,
 *     assignType: 'user'|'group', assigneeId, assigneeName,
 *     recurrence: { freq:'daily'|'weekly'|'monthly', daysOfWeek:[1..7], dayOfMonth:1..31 },
 *     active, createdAt, updatedAt, createdBy, lastGeneratedDate }
 *
 * Instantie:
 *   { id, taskId, title, description, assignType, assigneeId, assigneeName,
 *     dueDate:'YYYY-MM-DD', status:'open'|'done', completedAt, completedBy, createdAt }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'admin/taken.json';
const clean = (v) => String(v == null ? '' : v).trim();

const VALID_FREQ = new Set(['daily', 'weekly', 'monthly']);

function genId(prefix = 't') {
  return (globalThis.crypto?.randomUUID)
    ? `${prefix}-${globalThis.crypto.randomUUID()}`
    : `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

/** YYYY-MM-DD in Europe/Amsterdam (zodat "vandaag" klopt met NL-tijd). */
export function todayNL(d = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam' }).format(d); /* en-CA → YYYY-MM-DD */
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** ISO-weekdag 1=ma .. 7=zo voor een YYYY-MM-DD string. */
function isoWeekday(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  const js = d.getDay(); /* 0=zo..6=za */
  return js === 0 ? 7 : js;
}

export async function readTaken() {
  const d = await readJsonBlob(PATH, { tasks: {}, instances: {}, updatedAt: null });
  return { tasks: d.tasks || {}, instances: d.instances || {}, updatedAt: d.updatedAt || null };
}

async function writeTaken(state) {
  await writeJsonBlob(PATH, { tasks: state.tasks || {}, instances: state.instances || {}, updatedAt: new Date().toISOString() });
}

export async function listTasks() {
  const { tasks } = await readTaken();
  return Object.values(tasks).sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), 'nl'));
}

export async function getTask(id) {
  const { tasks } = await readTaken();
  return tasks[clean(id)] || null;
}

function normalizeRecurrence(input = {}) {
  const freq = VALID_FREQ.has(clean(input.freq)) ? clean(input.freq) : 'weekly';
  const out = { freq };
  if (freq === 'weekly') {
    const days = Array.isArray(input.daysOfWeek) ? input.daysOfWeek.map((n) => Number(n)).filter((n) => n >= 1 && n <= 7) : [];
    out.daysOfWeek = days.length ? [...new Set(days)].sort((a, b) => a - b) : [1]; /* default ma */
  } else if (freq === 'monthly') {
    let dom = Number(input.dayOfMonth);
    if (!Number.isFinite(dom) || dom < 1) dom = 1;
    if (dom > 28) dom = 28; /* veilig: bestaat in elke maand */
    out.dayOfMonth = dom;
  }
  return out;
}

/** Beschrijf de herhaling in NL voor de UI. */
export function describeRecurrence(rec = {}) {
  const dagen = ['', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
  if (rec.freq === 'daily') return 'Elke dag';
  if (rec.freq === 'monthly') return `Maandelijks op dag ${rec.dayOfMonth || 1}`;
  const ds = (rec.daysOfWeek || [1]).map((n) => dagen[n]).filter(Boolean);
  return `Wekelijks (${ds.join(', ')})`;
}

export async function upsertTask(input = {}, actor = 'admin') {
  const state = await readTaken();
  const now = new Date().toISOString();
  const title = clean(input.title);
  if (!title) throw new Error('Titel is verplicht.');
  const assignType = input.assignType === 'group' ? 'group' : 'user';
  const assigneeId = clean(input.assigneeId);
  if (!assigneeId) throw new Error('Kies een persoon of groep om aan toe te wijzen.');

  const id = clean(input.id) || genId('task');
  const existing = state.tasks[id] || {};
  state.tasks[id] = {
    id,
    title,
    description: clean(input.description) || existing.description || '',
    assignType,
    assigneeId,
    assigneeName: clean(input.assigneeName) || existing.assigneeName || assigneeId,
    recurrence: normalizeRecurrence(input.recurrence || existing.recurrence || {}),
    active: input.active !== undefined ? Boolean(input.active) : (existing.active !== undefined ? existing.active : true),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || clean(actor) || 'admin',
    lastGeneratedDate: existing.lastGeneratedDate || null
  };
  await writeTaken(state);
  return state.tasks[id];
}

export async function deleteTask(id) {
  const state = await readTaken();
  const tid = clean(id);
  if (!state.tasks[tid]) return { removed: false };
  delete state.tasks[tid];
  /* Bijbehorende open instanties opruimen; afgeronde blijven als historie. */
  for (const [iid, inst] of Object.entries(state.instances)) {
    if (inst.taskId === tid && inst.status !== 'done') delete state.instances[iid];
  }
  await writeTaken(state);
  return { removed: true };
}

/** Is een taak op de gegeven datum (YYYY-MM-DD) van toepassing? */
export function isTaskDue(task, dateStr) {
  if (!task || task.active === false) return false;
  const rec = task.recurrence || {};
  if (rec.freq === 'daily') return true;
  if (rec.freq === 'monthly') {
    const dom = Number(rec.dayOfMonth || 1);
    return Number(dateStr.slice(8, 10)) === dom;
  }
  /* weekly */
  return (rec.daysOfWeek || [1]).includes(isoWeekday(dateStr));
}

function instanceExists(state, taskId, dueDate) {
  return Object.values(state.instances).some((i) => i.taskId === taskId && i.dueDate === dueDate);
}

/**
 * Genereer instanties voor alle actieve taken die op `dateStr` vervallen en nog
 * geen instantie voor die dag hebben. Returnt de nieuw aangemaakte instanties.
 */
export async function generateDueInstances(dateStr = todayNL()) {
  const state = await readTaken();
  const created = [];
  const now = new Date().toISOString();
  for (const task of Object.values(state.tasks)) {
    if (!isTaskDue(task, dateStr)) continue;
    if (instanceExists(state, task.id, dateStr)) continue;
    const inst = {
      id: genId('inst'),
      taskId: task.id,
      title: task.title,
      description: task.description || '',
      assignType: task.assignType,
      assigneeId: task.assigneeId,
      assigneeName: task.assigneeName || task.assigneeId,
      dueDate: dateStr,
      status: 'open',
      completedAt: null,
      completedBy: '',
      createdAt: now
    };
    state.instances[inst.id] = inst;
    state.tasks[task.id].lastGeneratedDate = dateStr;
    created.push(inst);
  }
  if (created.length) await writeTaken(state);
  return created;
}

export async function completeInstance(instanceId, by = '') {
  const state = await readTaken();
  const inst = state.instances[clean(instanceId)];
  if (!inst) return null;
  if (inst.status !== 'done') {
    inst.status = 'done';
    inst.completedAt = new Date().toISOString();
    inst.completedBy = clean(by) || 'onbekend';
    await writeTaken(state);
  }
  return inst;
}

export async function reopenInstance(instanceId) {
  const state = await readTaken();
  const inst = state.instances[clean(instanceId)];
  if (!inst) return null;
  inst.status = 'open';
  inst.completedAt = null;
  inst.completedBy = '';
  await writeTaken(state);
  return inst;
}

/** Alle instanties (optioneel gefilterd). */
export async function listInstances({ status = null, taskId = null } = {}) {
  const { instances } = await readTaken();
  let arr = Object.values(instances);
  if (status) arr = arr.filter((i) => i.status === status);
  if (taskId) arr = arr.filter((i) => i.taskId === taskId);
  return arr.sort((a, b) => String(b.dueDate).localeCompare(String(a.dueDate)));
}

/**
 * Open + recent-afgeronde instanties voor een specifieke gebruiker:
 * eigen (assignType user + assigneeId) + groep (assignType group + lid van groep).
 */
export async function listInstancesForUser({ userId, groupKeys = [], includeDoneDays = 7 } = {}) {
  const { instances } = await readTaken();
  const uid = clean(userId);
  const groups = new Set((groupKeys || []).map(clean).filter(Boolean));
  const cutoff = todayNL(new Date(Date.now() - includeDoneDays * 86400000));
  const mine = Object.values(instances).filter((i) => {
    const forMe = (i.assignType === 'user' && i.assigneeId === uid)
      || (i.assignType === 'group' && groups.has(i.assigneeId));
    if (!forMe) return false;
    if (i.status === 'open') return true;
    return i.dueDate >= cutoff; /* recent afgerond tonen */
  });
  return mine.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'open' ? -1 : 1;
    return String(a.dueDate).localeCompare(String(b.dueDate));
  });
}

export function summarize(state) {
  const tasks = Object.values(state.tasks || {});
  const instances = Object.values(state.instances || {});
  const today = todayNL();
  return {
    totaalTaken: tasks.length,
    actief: tasks.filter((t) => t.active !== false).length,
    openInstanties: instances.filter((i) => i.status === 'open').length,
    teLaat: instances.filter((i) => i.status === 'open' && i.dueDate < today).length,
    vandaag: instances.filter((i) => i.status === 'open' && i.dueDate === today).length
  };
}
