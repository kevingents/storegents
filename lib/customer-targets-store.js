/**
 * Klanten-targets per maand per winkel — Blob-backed.
 *
 * Per (year, month, store) sla 3 targets op:
 *   - inschrijvingen     (totaal aantal nieuwe klanten in de maand)
 *   - metBon             (van de nieuwe klanten: die ook een bon kreeg gekoppeld)
 *   - metEmail           (van de nieuwe klanten: die ook email opgaf)
 *
 * Blob: admin/customer-targets.json
 *   {
 *     targets: {
 *       '2026-05': {
 *         'GENTS Arnhem':   { inschrijvingen: 80, metBon: 70, metEmail: 60 },
 *         'GENTS Almere':   { inschrijvingen: 100, metBon: 85, metEmail: 70 },
 *         ...
 *       },
 *       '2026-06': { ... }
 *     },
 *     updatedAt, updatedBy
 *   }
 *
 * Het zip-bestand kan ook ALL stores defaults bevatten via key '_default':
 *   targets['2026-05']._default = { inschrijvingen: 50, metBon: 40, metEmail: 35 }
 * Dat fungeert als fallback voor winkels zonder eigen target voor die maand.
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'admin/customer-targets.json';

function clean(v) { return String(v ?? '').trim(); }
function nowIso() { return new Date().toISOString(); }

function monthKey(year, month) {
  const y = Number(year) || new Date().getUTCFullYear();
  const m = Number(month) || (new Date().getUTCMonth() + 1);
  return `${y}-${String(m).padStart(2, '0')}`;
}

function safeNumber(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function normalizeTargetRow(input) {
  return {
    inschrijvingen: safeNumber(input?.inschrijvingen),
    metBon: safeNumber(input?.metBon),
    metEmail: safeNumber(input?.metEmail)
  };
}

export async function readAllTargets() {
  const data = await readJsonBlob(STORE_PATH, { targets: {} });
  return data.targets && typeof data.targets === 'object' ? data.targets : {};
}

export async function getTargetsForMonth(year, month) {
  const all = await readAllTargets();
  return all[monthKey(year, month)] || {};
}

/**
 * Lookup target voor een specifieke winkel + maand.
 * Geeft per-winkel target, anders _default voor die maand, anders nulls.
 */
export async function getTargetForStore(year, month, store) {
  const monthData = await getTargetsForMonth(year, month);
  const storeKey = clean(store);
  const own = monthData[storeKey];
  if (own) return normalizeTargetRow(own);
  const def = monthData._default;
  if (def) return normalizeTargetRow(def);
  return { inschrijvingen: 0, metBon: 0, metEmail: 0 };
}

/**
 * Bulk-targets ophalen voor meerdere winkels in één maand (efficiënter dan
 * per winkel lookups). Returned dict: { store → target }.
 */
export async function getTargetsForStores(year, month, stores = []) {
  const monthData = await getTargetsForMonth(year, month);
  const def = monthData._default || null;
  const result = {};
  for (const s of stores) {
    const key = clean(s);
    const own = monthData[key];
    result[key] = normalizeTargetRow(own || def || {});
  }
  return result;
}

export async function upsertTarget(year, month, store, patch = {}, actor = 'admin') {
  const mk = monthKey(year, month);
  const storeKey = clean(store) || '_default';
  const next = await mutateJsonBlob(STORE_PATH, (data0) => {
    const data = (data0 && typeof data0 === 'object') ? data0 : {};
    const targets = data.targets || {};
    if (!targets[mk]) targets[mk] = {};
    targets[mk][storeKey] = normalizeTargetRow({
      ...(targets[mk][storeKey] || {}),
      ...patch
    });
    return { targets, updatedAt: nowIso(), updatedBy: clean(actor) || 'admin' };
  }, { fallback: { targets: {} } });
  return next.targets[mk][storeKey];
}

/**
 * Bulk-upsert voor heel een maand in 1 call: { store → patch }.
 * Heel handig voor de UI: alle targets van een maand in één keer opslaan.
 *
 * Gebruikt mutateJsonBlob: verse (cache-busted) read-modify-write zodat de
 * blob nooit met stale data wordt overschreven, en de write no-cache is zodat
 * een directe reload meteen de nieuwe targets ziet (geen 30s CDN-venster meer).
 */
export async function bulkUpsertMonth(year, month, byStore = {}, actor = 'admin') {
  const mk = monthKey(year, month);
  const next = await mutateJsonBlob(STORE_PATH, (data0) => {
    const data = (data0 && typeof data0 === 'object') ? data0 : {};
    const targets = data.targets || {};
    if (!targets[mk]) targets[mk] = {};
    for (const [store, patch] of Object.entries(byStore || {})) {
      const key = clean(store) || '_default';
      targets[mk][key] = normalizeTargetRow({
        ...(targets[mk][key] || {}),
        ...patch
      });
    }
    return { targets, updatedAt: nowIso(), updatedBy: clean(actor) || 'admin' };
  }, { fallback: { targets: {} } });
  return next.targets[mk];
}

export async function deleteTarget(year, month, store) {
  const mk = monthKey(year, month);
  const storeKey = clean(store);
  let removed = false;
  await mutateJsonBlob(STORE_PATH, (data0) => {
    const data = (data0 && typeof data0 === 'object') ? data0 : {};
    const targets = data.targets || {};
    if (!targets[mk] || !targets[mk][storeKey]) { removed = false; return data; }
    delete targets[mk][storeKey];
    if (!Object.keys(targets[mk]).length) delete targets[mk];
    removed = true;
    return { ...data, targets, updatedAt: nowIso() };
  }, { fallback: { targets: {} } });
  return removed;
}

/**
 * Helper: compute percentage met afronding en safe-division.
 * pct(40, 80) = 50 (50%)
 * pct(0, 0)   = null (geen target gesteld → niet tonen)
 * pct(50, 0)  = null
 */
export function calcPct(actual, target) {
  const a = Number(actual) || 0;
  const t = Number(target) || 0;
  if (t <= 0) return null;
  return Math.round((a / t) * 100);
}

/**
 * Bepaal status-kleur op basis van %.
 *   >= 100  → 'success'
 *   >= 80   → 'good'
 *   >= 50   → 'warning'
 *   <  50   → 'danger'
 *   null    → 'muted'
 */
export function pctColor(pct) {
  if (pct == null) return 'muted';
  if (pct >= 100) return 'success';
  if (pct >= 80) return 'good';
  if (pct >= 50) return 'warning';
  return 'danger';
}
