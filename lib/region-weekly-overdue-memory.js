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

export function makeWeeklyStoreRow(store) {
  return {
    store,
    openCount: 0,
    currentOverdueCount: 0,
    overdueCount: 0,
    oldestAgeHours: 0,
    overdueKeys: new Set(),
    currentOverdueKeys: new Set(),
    historicalOverdueKeys: new Set(),
    historicalOrders: []
  };
}

export function ensureWeeklyStoreRow(map, store) {
  const key = clean(store);
  if (!map.has(key)) map.set(key, makeWeeklyStoreRow(key));
  return map.get(key);
}

export function addCurrentOverdueOrder(map, store, row, key, oldestAgeHours = 0) {
  const target = ensureWeeklyStoreRow(map, store);
  const k = clean(key);
  if (!k || target.overdueKeys.has(k)) return target;
  target.overdueKeys.add(k);
  target.currentOverdueKeys.add(k);
  target.overdueCount += 1;
  target.currentOverdueCount += 1;
  target.oldestAgeHours = Math.max(Number(target.oldestAgeHours || 0), Number(oldestAgeHours || 0));
  return target;
}

export async function addLoggedWeeklyOverdueOrders(map, { dateFrom, dateTo }) {
  const rows = await getMailLog();

  for (const row of rows || []) {
    if (!inRange(row, dateFrom, dateTo)) continue;
    if (!['weborder_overdue_store', 'weborder_overdue_region_manager'].includes(row.type)) continue;
    if (!['sent', 'dry_run'].includes(clean(row.status))) continue;

    const store = clean(row.store);
    const key = clean(row.key || row.order);
    if (!store || !key) continue;

    const target = ensureWeeklyStoreRow(map, store);
    if (target.overdueKeys.has(key)) continue;

    target.overdueKeys.add(key);
    target.historicalOverdueKeys.add(key);
    target.overdueCount += 1;
    target.historicalOrders.push({
      order: row.order || key,
      key,
      createdAt: row.createdAt || row.sentAt || '',
      source: row.type
    });
  }

  return map;
}

export function weeklyStoreRowToJson(row) {
  return {
    ...row,
    overdueKeys: Array.from(row.overdueKeys || []),
    currentOverdueKeys: Array.from(row.currentOverdueKeys || []),
    historicalOverdueKeys: Array.from(row.historicalOverdueKeys || [])
  };
}
