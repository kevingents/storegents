/**
 * lib/weekly-overdue-snapshot-store.js
 *
 * Houdt per winkel bij WELKE weborders te laat waren, met de datum waarop ze
 * voor het eerst als te laat gezien zijn (firstSeen). Een dagelijkse cron
 * (api/cron/overdue-snapshot.js) voedt dit. Zo telt het weekrapport "te laat in
 * periode" volledig - ook orders die inmiddels alweer verwerkt zijn - los van
 * wat er toevallig gemaild (en dus in de mail-log gelogd) is.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'reports/weekly-overdue-snapshot.json';
const MAX_AGE_DAYS = Number(process.env.OVERDUE_SNAPSHOT_MAX_DAYS || 60);
const SEP = '::'; /* scheidt store en order-key in de map-sleutel */

const clean = (v) => String(v == null ? '' : v).trim();
const dayKey = (d = new Date()) => d.toISOString().slice(0, 10);

export async function readOverdueSnapshot() {
  return (await readJsonBlob(PATH, null)) || { firstSeen: {}, updatedAt: null };
}

/**
 * Registreer te-late orders. entries = [{ store, key }]. Nieuwe (store,key)-
 * combinaties krijgen de firstSeen-datum van vandaag; bestaande blijven staan.
 * Oude entries (> MAX_AGE_DAYS) worden opgeruimd.
 */
export async function recordOverdueOrders(entries = [], todayIso) {
  const today = clean(todayIso) || dayKey();
  const snap = await readOverdueSnapshot();
  const fs = snap.firstSeen || {};
  let added = 0;
  for (const e of entries) {
    const store = clean(e && e.store);
    const key = clean(e && e.key);
    if (!store || !key) continue;
    const id = `${store}${SEP}${key}`;
    if (!fs[id]) { fs[id] = today; added += 1; }
  }
  const cutoff = dayKey(new Date(Date.now() - MAX_AGE_DAYS * 86400000));
  for (const [id, day] of Object.entries(fs)) if (String(day) < cutoff) delete fs[id];
  snap.firstSeen = fs;
  snap.updatedAt = new Date().toISOString();
  try { await writeJsonBlob(PATH, snap); } catch (_) {}
  return { added, total: Object.keys(fs).length };
}

/**
 * Voeg historische te-late orders (firstSeen binnen [dateFrom, dateTo]) per
 * winkel toe aan een weekly-store-map (zelfde vorm als region-weekly-overdue-
 * memory). Deduped via overdueKeys, zodat het naast de live + mail-log bronnen
 * kan draaien zonder dubbeltellen.
 */
export async function addSnapshotWeeklyOverdueOrders(map, { dateFrom, dateTo, ensureWeeklyStoreRow }) {
  if (typeof ensureWeeklyStoreRow !== 'function') return map;
  const snap = await readOverdueSnapshot();
  const fs = snap.firstSeen || {};
  for (const [id, day] of Object.entries(fs)) {
    const d = String(day);
    if (dateFrom && d < dateFrom) continue;
    if (dateTo && d > dateTo) continue;
    const idx = id.indexOf(SEP);
    if (idx < 0) continue;
    const store = id.slice(0, idx);
    const key = id.slice(idx + SEP.length);
    const target = ensureWeeklyStoreRow(map, store);
    if (target.overdueKeys.has(key)) continue;
    target.overdueKeys.add(key);
    if (target.historicalOverdueKeys) target.historicalOverdueKeys.add(key);
    target.overdueCount += 1;
  }
  return map;
}
