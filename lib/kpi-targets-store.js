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

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';
import { getKpiByKey } from './kpi-registry.js';

const CONFIG_PATH = 'admin/kpi-config.json';

/**
 * Legacy bridge: mapping van KPI-keys naar velden in customer-targets-store
 * (admin/customer-targets.json). Wanneer er voor deze KPIs nog GEEN value in
 * admin/kpi-config.json staat, valt getTarget() automatisch terug op de
 * oude store. Hierdoor breekt het customer-targets endpoint niet en
 * verschijnen historische targets ook in het KPI-systeem.
 *
 * Migratie naar de nieuwe store gebeurt impliciet: zodra een admin een
 * target opslaat via /api/admin/kpis/targets, komt 'ie in kpi-config.json
 * en wint die voortaan via cascade.
 */
const LEGACY_CUSTOMER_TARGET_MAP = Object.freeze({
  customers_new:        'inschrijvingen',
  customers_with_bon:   'metBon',
  customers_with_email: 'metEmail'
});

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
 * Returns het volledige targets-blok: { 'YYYY-MM' → { store → { kpi → value } } }.
 * Eén blob-read; handig voor rapporten die over meerdere maanden willen kijken
 * of een "laatst-ingestelde target"-fallback nodig hebben.
 */
export async function readAllKpiTargets() {
  const data = await readJsonBlob(CONFIG_PATH, { targets: {} });
  return data.targets || {};
}

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
 *   3. LEGACY: customer-targets-store fallback (alleen voor customer-KPIs)
 *   4. null  (geen target gezet)
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

  /* Legacy bridge: lees customer-targets als KPI nog niet gemigreerd is. */
  const legacyField = LEGACY_CUSTOMER_TARGET_MAP[kpi];
  if (legacyField) {
    try {
      const ct = await import('./customer-targets-store.js');
      const row = await ct.getTargetForStore(year, month, store);
      const v = row?.[legacyField];
      if (v != null && Number(v) > 0) return safeNumber(v);
    } catch (e) {
      /* customer-targets-store niet beschikbaar — fall through to null */
    }
  }

  return null;
}

/**
 * Bulk-lookup: returnt voor meerdere winkels in 1 maand alle KPI-targets.
 * Inclusief legacy customer-targets fallback per store.
 *
 * @returns {Promise<{[store]: {[kpiKey]: number|null}}>}
 */
export async function getTargetsForStores(year, month, stores = []) {
  const monthData = await getTargetsForMonth(year, month);
  const def = monthData._default || {};

  /* Eenmalig oude customer-targets ophalen voor de hele maand (efficienter
     dan per-store import doen). Falen is OK — dan geen fallback. */
  let legacyMonthMap = {};
  try {
    const ct = await import('./customer-targets-store.js');
    legacyMonthMap = await ct.getTargetsForMonth(year, month);
  } catch (e) { /* customer-targets niet beschikbaar */ }

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
    /* Legacy bridge: voor customer-KPIs zonder waarde, val terug op
       de oude customer-targets-store-data. */
    const legacyRow = legacyMonthMap[k] || legacyMonthMap._default || {};
    for (const [kpiKey, ctField] of Object.entries(LEGACY_CUSTOMER_TARGET_MAP)) {
      if (out[kpiKey] == null && legacyRow[ctField] != null) {
        const v = Number(legacyRow[ctField]);
        if (Number.isFinite(v) && v > 0) out[kpiKey] = v;
      }
    }
    result[k] = out;
  }
  return result;
}

/**
 * Migreer alle bestaande customer-targets data naar de KPI-targets-store.
 *
 * Eenmalig (idempotent) helper: leest admin/customer-targets.json,
 * converteert inschrijvingen/metBon/metEmail → customers_new/with_bon/with_email,
 * en schrijft naar admin/kpi-config.json. Bestaande KPI-targets worden NIET
 * overschreven — alleen ontbrekende velden worden bijgevuld.
 *
 * Roep aan via POST /api/admin/kpis/migrate-customer-targets.
 *
 * @returns {Promise<{migrated: number, skipped: number, months: string[]}>}
 */
export async function migrateCustomerTargetsToKpi(actor = 'admin') {
  let ct;
  try { ct = await import('./customer-targets-store.js'); }
  catch (e) { throw new Error('customer-targets-store niet beschikbaar'); }

  const allOld = await ct.readAllTargets();

  let migrated = 0;
  let skipped = 0;
  let monthsTouched = [];

  await mutateJsonBlob(CONFIG_PATH, (data0) => {
    const data = (data0 && typeof data0 === 'object') ? data0 : {};
    const targets = data.targets || {};
    /* Tellers resetten per (retry-)poging zodat ze de werkelijk geschreven staat weerspiegelen. */
    migrated = 0; skipped = 0;
    const touched = new Set();

    for (const [mk, monthData] of Object.entries(allOld || {})) {
      for (const [storeKey, row] of Object.entries(monthData || {})) {
        if (!targets[mk]) targets[mk] = {};
        if (!targets[mk][storeKey]) targets[mk][storeKey] = {};
        const dest = targets[mk][storeKey];

        for (const [kpiKey, ctField] of Object.entries(LEGACY_CUSTOMER_TARGET_MAP)) {
          const v = Number(row?.[ctField]);
          if (!Number.isFinite(v) || v <= 0) { skipped += 1; continue; }
          if (dest[kpiKey] != null) { skipped += 1; continue; } /* niet overschrijven */
          dest[kpiKey] = v;
          migrated += 1;
          touched.add(mk);
        }
      }
    }
    monthsTouched = Array.from(touched).sort();
    return { ...data, targets, updatedAt: new Date().toISOString(), updatedBy: clean(actor) || 'admin' };
  }, { fallback: { overrides: {}, targets: {}, reportBindings: {} } });

  return { migrated, skipped, months: monthsTouched };
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

  /* Validatie + waarde-coercie buiten de mutator (1x, niet per retry). */
  const remove = (value === null || value === undefined || value === '');
  let n = null;
  if (!remove) {
    n = safeNumber(value);
    if (n === null) throw new Error(`Ongeldige waarde voor ${k}: ${value}`);
  }

  /* mutateJsonBlob: verse (cache-busted) read-modify-write + optimistische
     concurrency + no-cache write. Voorkomt lost-updates bij meerdere
     gelijktijdige target-saves én stale reads direct na opslaan. */
  const next = await mutateJsonBlob(CONFIG_PATH, (data0) => {
    const data = (data0 && typeof data0 === 'object') ? data0 : {};
    const targets = data.targets || {};
    if (!targets[mk]) targets[mk] = {};
    if (!targets[mk][storeKey]) targets[mk][storeKey] = {};
    if (remove) {
      delete targets[mk][storeKey][k];
      if (Object.keys(targets[mk][storeKey]).length === 0) delete targets[mk][storeKey];
    } else {
      targets[mk][storeKey][k] = n;
    }
    return { ...data, targets, updatedAt: new Date().toISOString(), updatedBy: actor };
  }, { fallback: { overrides: {}, targets: {}, reportBindings: {} } });

  return next.targets[mk] || {};
}

/**
 * Bulk-upsert: complete maand-row overschrijven voor 1 winkel.
 * @param {Object} kpiValues  { sales_revenue: 50000, customers_new: 80, ... }
 */
export async function setTargetsForStore(year, month, store, kpiValues = {}, actor = 'admin') {
  const storeKey = clean(store) || '_default';
  const mk = monthKey(year, month);

  const cleaned = {};
  for (const [k, v] of Object.entries(kpiValues)) {
    const key = clean(k);
    if (!key) continue;
    const n = safeNumber(v);
    if (n !== null) cleaned[key] = n;
  }

  const next = await mutateJsonBlob(CONFIG_PATH, (data0) => {
    const data = (data0 && typeof data0 === 'object') ? data0 : {};
    const targets = data.targets || {};
    if (!targets[mk]) targets[mk] = {};
    if (Object.keys(cleaned).length === 0) {
      delete targets[mk][storeKey];
    } else {
      targets[mk][storeKey] = cleaned;
    }
    return { ...data, targets, updatedAt: new Date().toISOString(), updatedBy: actor };
  }, { fallback: { overrides: {}, targets: {}, reportBindings: {} } });

  return next.targets[mk] || {};
}

/**
 * Bulk-upsert voor de HELE maand in 1 atomaire write: { store → { kpi → value } }.
 * Elke winkel-rij wordt vervangen door de meegestuurde waarden (lege waarden
 * vallen weg). Eén mutateJsonBlob-transactie zodat álle winkels samen in één
 * keer worden weggeschreven — geen kans dat rij-voor-rij opslaan eerdere
 * winkels overschrijft. Voor de "Sla alles op"-knop in de KPI-modal.
 */
export async function setAllTargetsForMonth(year, month, byStore = {}, actor = 'admin') {
  const mk = monthKey(year, month);

  /* Buiten de mutator opschonen (1x, niet per retry). */
  const cleanedByStore = {};
  for (const [store, kpiValues] of Object.entries(byStore || {})) {
    const storeKey = clean(store) || '_default';
    const cleaned = {};
    for (const [k, v] of Object.entries(kpiValues || {})) {
      const key = clean(k);
      if (!key) continue;
      const n = safeNumber(v);
      if (n !== null) cleaned[key] = n;
    }
    cleanedByStore[storeKey] = cleaned;
  }

  const next = await mutateJsonBlob(CONFIG_PATH, (data0) => {
    const data = (data0 && typeof data0 === 'object') ? data0 : {};
    const targets = data.targets || {};
    if (!targets[mk]) targets[mk] = {};
    for (const [storeKey, cleaned] of Object.entries(cleanedByStore)) {
      if (Object.keys(cleaned).length === 0) delete targets[mk][storeKey];
      else targets[mk][storeKey] = cleaned;
    }
    return { ...data, targets, updatedAt: new Date().toISOString(), updatedBy: actor };
  }, { fallback: { overrides: {}, targets: {}, reportBindings: {} } });

  return next.targets[mk] || {};
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
  setAllTargetsForMonth,
  listMonthsWithTargets
};
