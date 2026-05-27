/**
 * lib/kpi-targets-store.js — targets per maand per winkel per KPI.
 *
 * Schema in blob admin/kpi-config.json (zelfde file als registry, andere key):
 *   {
 *     targets: {
 *       '2026-05': {
 *         'GENTS Arnhem': { sales_revenue: 50000, customers_new: 80, on_time_delivery: 95 },
 *         'GENTS Almere': { sales_revenue: 65000, customers_new: 100 },
 *         '_default':     { sales_revenue: 30000, customers_new: 50, on_time_delivery: 90 }
 *       }
 *     }
 *   }
 *
 * `_default` fungeert als fallback voor winkels zonder eigen target voor die maand.
 *
 * Belangrijke ontwerpkeuze: targets zijn NIET in de KPI-registry zelf —
 * de registry beschrijft de KPI-definitie (vaste data per release), terwijl
 * targets per-maand en per-winkel veranderen (vluchtige data). Door deze
 * gescheiden te houden kan een non-dev targets aanpassen zonder risico op
 * KPI-definitie-mutaties.
 *
 * NB: alle targets liggen in HETZELFDE blob als de registry-overrides
 * (admin/kpi-config.json). Eén file, twee subkeys. Dat houdt het
 * blob-aantal laag (Vercel Blob heeft soft-limiet op aantal entries).
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { getKpiByKey } from './kpi-registry.js';

const CONFIG_PATH = 'admin/kpi-config.json';

function clean(v) { return String(v ?? '').trim(); }

function monthKey(year, month) {
  const y = Number(year) || new Date().getUTCFullYear();
  const m = Number(month) || (new Date().getUTCMonth() + 1);
  return `${y}-${String(m).padStart(2, '0')}`;
}

function safeNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/* ──────────────────────────────────────────────────────────────────────
 * Lees-helpers
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Returns alle targets voor 1 maand: { storeName → { kpi_key → value } }.
 */
export async function getTargetsForMonth(year, month) {
  const data = await readJsonBlob(CONFIG_PATH, { targets: {} });
  const mk = monthKey(year, month);
  return data.targets?.[mk] || {};
}

/**
 * Lookup 1 specifieke target.
 *
 * Cascade:
 *   1. expliciete (store, kpi) value voor die maand
 *   2. _default value voor die maand
 *   3. null  (geen target gezet)
 *
 * @param {number} year
 * @param {number} month  (1-12)
 * @param {string} store  winkelnaam (bv. 'GENTS Arnhem')
 * @param {string} kpiKey KPI-key
 * @returns {Promise<number|null>}
 */
export async function getTarget(year, month, store, kpiKey) {
  const monthData = await getTargetsForMonth(year, month);
  const storeKey = clean(store);
  const kpi = clean(kpiKey);
  if (!kpi) return null;

  const own = monthData[storeKey];
  if (own && own[kpi] !== undefined) return safeNumber(own[kpi]);

  const def = monthData._default;
  if (def && def[kpi] !== undefined) return safeNumber(def[kpi]);

  return null;
}

/**
 * Bulk-lookup: returnt voor meerdere winkels in 1 maand alle KPI-targets.
 *
 * @returns {Promise<{[store]: {[kpiKey]: number|null}}>}
 */
export async function getTargetsForStores(year, month, stores = []) {
  const monthData = await getTargetsForMonth(year, month);
  const def = monthData._default || {};
  const result = {};
  for (const s of stores) {
    const k = clean(s);
    const own = monthData[k] || {};
    /* merge: own override default per-kpi */
    const merged = { ...def, ...own };
    /* coerce all to number|null */
    const out = {};
    for (const [kpiKey, val] of Object.entries(merged)) {
      out[kpiKey] = safeNumber(val);
    }
    result[k] = out;
  }
  return result;
}

/**
 * Bulk-lookup per maand, 1 KPI, alle winkels:  { storeName → target }.
 * Handig voor rapport-tabellen die 1 KPI per kolom tonen.
 */
export async function getTargetForAllStores(year, month, kpiKey) {
  const monthData = await getTargetsForMonth(year, month);
  const k = clean(kpiKey);
  if (!k) return {};
  const def = monthData._default?.[k];
  const result = {};
  for (const [store, row] of Object.entries(monthData)) {
    if (store === '_default') continue;
    const v = row && row[k] !== undefined ? row[k] : def;
    result[store] = safeNumber(v);
  }
  /* expose _default explicitly zodat caller weet welke fallback geldt */
  if (def !== undefined) result._default = safeNumber(def);
  return result;
}

/* ──────────────────────────────────────────────────────────────────────
 * Schrijf-helpers (admin-API)
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Upsert 1 target. Gebruik store='_default' om de fallback voor de maand te zetten.
 *
 * @param {number} year
 * @param {number} month
 * @param {string} store    winkelnaam of '_default'
 * @param {string} kpiKey   moet bestaan in KPI-registry
 * @param {number|null} value  null = verwijder target
 * @param {string} actor
 */
export async function setTarget(year, month, store, kpiKey, value, actor = 'admin') {
  const k = clean(kpiKey);
  if (!k) throw new Error('KPI-key is verplicht.');

  /* Valideer dat KPI bestaat */
  const kpi = await getKpiByKey(k);
  if (!kpi) throw new Error(`Onbekende KPI: ${k}`);
  if (!kpi.hasTarget) throw new Error(`KPI '${k}' ondersteunt geen targets (hasTarget=false).`);

  const storeKey = clean(store) || '_default';
  const mk = monthKey(year, month);

  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, targets: {}, reportBindings: {} });
  const targets = data.targets || {};
  if (!targets[mk]) targets[mk] = {};
  if (!targets[mk][storeKey]) targets[mk][storeKey] = {};

  if (value === null || value === undefined || value === '') {
    delete targets[mk][storeKey][k];
    /* opruim: lege store-rows weg */
    if (Object.keys(targets[mk][storeKey]).length === 0) {
      delete targets[mk][storeKey];
    }
  } else {
    const n = safeNumber(value);
    if (n === null) throw new Error(`Ongeldige waarde voor ${k}: ${value}`);
    targets[mk][storeKey][k] = n;
  }

  await writeJsonBlob(CONFIG_PATH, {
    ...data,
    targets,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  });

  return targets[mk] || {};
}

/**
 * Bulk-upsert: complete maand-row overschrijven voor 1 winkel.
 * @param {Object} kpiValues  { sales_revenue: 50000, customers_new: 80, ... }
 */
export async function setTargetsForStore(year, month, store, kpiValues = {}, actor = 'admin') {
  const storeKey = clean(store) || '_default';
  const mk = monthKey(year, month);

  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, targets: {}, reportBindings: {} });
  const targets = data.targets || {};
  if (!targets[mk]) targets[mk] = {};

  const cleaned = {};
  for (const [k, v] of Object.entries(kpiValues)) {
    const key = clean(k);
    if (!key) continue;
    const n = safeNumber(v);
    if (n !== null) cleaned[key] = n;
  }
  if (Object.keys(cleaned).length === 0) {
    delete targets[mk][storeKey];
  } else {
    targets[mk][storeKey] = cleaned;
  }

  await writeJsonBlob(CONFIG_PATH, {
    ...data,
    targets,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  });

  return targets[mk] || {};
}

/**
 * Returnt alle months waarvoor targets bestaan.
 */
export async function listMonthsWithTargets() {
  const data = await readJsonBlob(CONFIG_PATH, { targets: {} });
  return Object.keys(data.targets || {}).sort();
}

export default {
  getTargetsForMonth,
  getTarget,
  getTargetsForStores,
  getTargetForAllStores,
  setTarget,
  setTargetsForStore,
  listMonthsWithTargets
};
