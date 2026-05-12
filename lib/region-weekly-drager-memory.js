import { getMailLog } from './gents-mail-log-store.js';

function clean(value) {
  return String(value ?? '').trim();
}

function start(dateText) {
  const d = new Date(`${dateText}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? new Date(0) : d;
}

function end(dateText) {
  const d = new Date(`${dateText}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function inRange(row, dateFrom, dateTo) {
  const d = new Date(row.createdAt || row.sentAt || row.time || 0);
  if (Number.isNaN(d.getTime())) return false;
  return d >= start(dateFrom) && d <= end(dateTo);
}

export function makeWeeklyDragerRow(store) {
  return {
    store,
    openCount: 0,
    currentOverdueCount: 0,
    overdueCount: 0,
    oldestAgeHours: 0,
    dragerKeys: new Set(),
    currentDragerKeys: new Set(),
    historicalDragerKeys: new Set(),
    historicalDragers: []
  };
}

export function ensureWeeklyDragerRow(map, store) {
  const key = clean(store) || 'Onbekend';
  if (!map.has(key)) map.set(key, makeWeeklyDragerRow(key));
  return map.get(key);
}

export function addCurrentOverdueDrager(map, store, row, key, oldestAgeHours = 0) {
  const target = ensureWeeklyDragerRow(map, store);
  const k = clean(key);
  if (!k || target.dragerKeys.has(k)) return target;
  target.dragerKeys.add(k);
  target.currentDragerKeys.add(k);
  target.overdueCount += 1;
  target.currentOverdueCount += 1;
  target.oldestAgeHours = Math.max(Number(target.oldestAgeHours || 0), Number(oldestAgeHours || 0));
  return target;
}

export async function addLoggedWeeklyDragers(map, { dateFrom, dateTo }) {
  const rows = await getMailLog();

  for (const row of rows || []) {
    if (!inRange(row, dateFrom, dateTo)) continue;
    if (!['drager_overdue_store', 'drager_overdue_region_manager'].includes(row.type)) continue;
    if (!['sent', 'dry_run'].includes(clean(row.status))) continue;

    const store = clean(row.store);
    const key = clean(row.key || row.order || row.dragerId);
    if (!store || !key) continue;

    const target = ensureWeeklyDragerRow(map, store);
    if (target.dragerKeys.has(key)) continue;

    target.dragerKeys.add(key);
    target.historicalDragerKeys.add(key);
    target.overdueCount += 1;
    target.historicalDragers.push({
      dragerId: row.order || row.dragerId || key,
      key,
      createdAt: row.createdAt || row.sentAt || '',
      message: row.message || '',
      source: row.type
    });
  }

  return map;
}

export function weeklyDragerRowToJson(row) {
  return {
    ...row,
    dragerKeys: Array.from(row.dragerKeys || []),
    currentDragerKeys: Array.from(row.currentDragerKeys || []),
    historicalDragerKeys: Array.from(row.historicalDragerKeys || [])
  };
}
