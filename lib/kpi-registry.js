/**
 * lib/kpi-registry.js — generieke KPI-registry voor de hele portal.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  WAT IS DIT?
 * ════════════════════════════════════════════════════════════════════════
 *
 * Centraal register van alle KPI's die we in de portal beheren — omzet,
 * klantinschrijvingen, on-time delivery, conversie, voorraad-correcties,
 * online-magazijn-tempo, omnichannel-score, etc.
 *
 * Voorheen waren KPI-definities versnipperd over:
 *   - lib/business-config.js          (omnichannel-weights hardcoded)
 *   - lib/customer-targets-store.js   (klanten-targets per winkel)
 *   - lib/supplychain-metrics-config.js (14 supplychain-KPI's)
 *   - lib/impact-score.js             (weights via env-vars)
 *
 * Dit bestand consolideert dat. Eén plek waar je een nieuwe KPI toevoegt
 * door 'm aan DEFAULT_KPIS toe te voegen + een fetcher in lib/kpi-sources/
 * te schrijven. Admin-UI pikt 'm automatisch op.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  HYBRID MODEL — wat is code, wat is config
 * ════════════════════════════════════════════════════════════════════════
 *
 * CODE (developer-only, vereist deploy):
 *   - KPI-definitie (key, label, unit, direction, category, source-fetcher)
 *   - Berekenings-logica (lib/kpi-sources/<key>.js)
 *
 * CONFIG (admin-UI, geen deploy nodig):
 *   - Aan/uit per KPI
 *   - Thresholds (warn/danger) — globaal of per-winkel
 *   - Targets per maand per winkel
 *   - Aan welke rapporten de KPI gekoppeld is
 *   - Label-override (in admin-UI taal kunnen we labels veranderen)
 *
 * ════════════════════════════════════════════════════════════════════════
 *  HOE EEN NIEUWE KPI TOEVOEGEN
 * ════════════════════════════════════════════════════════════════════════
 *
 * 1. Voeg entry toe aan DEFAULT_KPIS hieronder
 * 2. Maak lib/kpi-sources/<key>.js met een default-export:
 *      export default async function compute({ store, period }) {
 *        return { value: 12345, meta: {...} };
 *      }
 * 3. Klaar — admin-UI laat 'm zien, hij is selecteerbaar voor rapporten,
 *    targets kunnen ingevoerd worden.
 *
 * ════════════════════════════════════════════════════════════════════════
 *  SCHEMA per KPI
 * ════════════════════════════════════════════════════════════════════════
 *
 *   key            (string)  unieke identifier, snake_case
 *   label          (string)  NL display-label
 *   description    (string)  korte uitleg voor tooltips + admin-UI
 *   category       (string)  'financieel'|'volume'|'service'|'kwaliteit'|'customer'|'composite'
 *   unit           (string)  'eur'|'count'|'pct'|'days'|'minutes'|'score'
 *   direction      (string)  'higher-better' | 'lower-better'
 *   scope          (string)  'per-store' | 'global' — wordt KPI per filiaal of voor heel GENTS gerapporteerd
 *   period         (string)  'day'|'week'|'month'|'quarter'|'year' — natuurlijke rapportage-periode
 *   icon           (string)  svgIcon-key uit frontend helper
 *   source         (object)  bron-config: { type, fetcher } — fetcher = bestandsnaam in lib/kpi-sources/
 *   thresholds     (object)  { warn, danger } — default-grenswaardes; admin kan overrulen
 *   hasTarget      (boolean) of targets per maand per winkel ingevoerd kunnen worden
 *   inReports      (string[]) welke rapporten deze KPI standaard tonen (= rapport-binding default)
 *   enabledByDefault (boolean) of de KPI standaard aan staat
 *   tags           (string[]) vrije labels voor filtering in UI ('winkel','online','urgentie',etc)
 *
 * Overrides per KPI (enabled, thresholds, label, inReports) komen uit
 * blob admin/kpi-config.json — zie lib/kpi-store.js.
 *
 * ════════════════════════════════════════════════════════════════════════
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const CONFIG_PATH = 'admin/kpi-config.json';
const READ_CACHE_TTL_MS = 60_000;

/* ──────────────────────────────────────────────────────────────────────
 * DEFAULT_KPIS — de canonical lijst.
 *
 * Wijzigingen hier vereisen een deploy. Voor runtime-aanpassingen
 * (label, thresholds, enabled) gebruik je de admin-UI → blob-overrides.
 * ────────────────────────────────────────────────────────────────────── */

export const DEFAULT_KPIS = [
  /* ═══════════════════════ FINANCIEEL ═══════════════════════ */
  {
    key: 'sales_revenue',
    label: 'Omzet',
    description: 'Bruto-omzet via SRS-kassa-bonnen + Shopify-weborders in periode.',
    category: 'financieel',
    unit: 'eur',
    direction: 'higher-better',
    scope: 'per-store',
    period: 'month',
    icon: 'money',
    source: { type: 'function', fetcher: 'sales-revenue' },
    thresholds: { warn: null, danger: null },
    hasTarget: false,
    inReports: ['region-weekly', 'omnichannel', 'store-dashboard'],
    enabledByDefault: true,
    tags: ['winkel', 'omzet']
  },
  {
    key: 'sales_units',
    label: 'Verkochte stuks',
    description: 'Totaal aantal verkochte artikelen via kassa + weborder in periode.',
    category: 'volume',
    unit: 'count',
    direction: 'higher-better',
    scope: 'per-store',
    period: 'month',
    icon: 'shopping-bag',
    source: { type: 'function', fetcher: 'sales-units' },
    thresholds: { warn: null, danger: null },
    hasTarget: false,
    inReports: ['region-weekly'],
    enabledByDefault: true,
    tags: ['winkel']
  },
  {
    key: 'conversion_rate',
    label: 'Conversie',
    description: 'Percentage Shopify-sessies dat resulteert in een order (sessions→orders).',
    category: 'financieel',
    unit: 'pct',
    direction: 'higher-better',
    scope: 'global', /* alleen voor online — niet per fysieke winkel */
    period: 'week',
    icon: 'trending-up',
    source: { type: 'function', fetcher: 'conversion-rate' },
    thresholds: { warn: 1.5, danger: 1.0 },
    hasTarget: false,
    inReports: ['online-dashboard', 'omnichannel'],
    enabledByDefault: true,
    tags: ['online']
  },

  /* ═══════════════════════ CUSTOMER ═══════════════════════ */
  {
    key: 'customers_new',
    label: 'Klantinschrijvingen',
    description: 'Aantal nieuwe klanten ingeschreven in periode (alle inschrijvingen).',
    category: 'customer',
    unit: 'count',
    direction: 'higher-better',
    scope: 'per-store',
    period: 'month',
    icon: 'user-plus',
    source: { type: 'function', fetcher: 'customers-new' },
    thresholds: { warn: null, danger: null },
    hasTarget: true,
    inReports: ['customer-weekly', 'region-weekly', 'omnichannel'],
    enabledByDefault: true,
    tags: ['winkel', 'customer']
  },
  {
    key: 'customers_with_bon',
    label: 'Klanten met bon',
    description: 'Nieuwe klanten die ook een transactie-bon gekoppeld kregen (= echte koper).',
    category: 'customer',
    unit: 'count',
    direction: 'higher-better',
    scope: 'per-store',
    period: 'month',
    icon: 'receipt',
    source: { type: 'function', fetcher: 'customers-with-bon' },
    thresholds: { warn: null, danger: null },
    hasTarget: false,
    inReports: ['customer-weekly'],
    enabledByDefault: true,
    tags: ['customer']
  },
  {
    key: 'customers_with_email',
    label: 'Klanten met email',
    description: 'Nieuwe klanten met email-adres (mail-bereikbaarheid).',
    category: 'customer',
    unit: 'count',
    direction: 'higher-better',
    scope: 'per-store',
    period: 'month',
    icon: 'mail',
    source: { type: 'function', fetcher: 'customers-with-email' },
    thresholds: { warn: null, danger: null },
    hasTarget: false,
    inReports: ['customer-weekly'],
    enabledByDefault: true,
    tags: ['customer']
  },

  /* ═══════════════════════ SERVICE / OPERATIONEEL ═══════════════════════ */
  {
    key: 'on_time_delivery',
    label: 'Op tijd leveren',
    description: '% weborders dat binnen de afgesproken deadline (zie business-config.deadlines) is verwerkt.',
    category: 'service',
    unit: 'pct',
    direction: 'higher-better',
    scope: 'per-store',
    period: 'week',
    icon: 'clock',
    source: { type: 'function', fetcher: 'on-time-delivery' },
    thresholds: { warn: 90, danger: 80 },
    hasTarget: false,
    inReports: ['region-weekly', 'omnichannel', 'supplychain'],
    enabledByDefault: true,
    tags: ['winkel', 'urgentie']
  },
  {
    key: 'overdue_orders',
    label: 'Te-late orders',
    description: 'Aantal openstaande weborders waarvan de deadline is verstreken op periode-einde.',
    category: 'service',
    unit: 'count',
    direction: 'lower-better',
    scope: 'per-store',
    period: 'week',
    icon: 'alert-triangle',
    source: { type: 'function', fetcher: 'overdue-orders' },
    thresholds: { warn: 3, danger: 10 },
    hasTarget: false,
    inReports: ['region-weekly', 'omnichannel'],
    enabledByDefault: true,
    tags: ['winkel', 'urgentie']
  },
  {
    key: 'online_warehouse_speed',
    label: 'Online-magazijn tempo',
    description: 'Gemiddelde tijd (uren) tussen weborder-aanmaak en gepickt-status. Lager = sneller magazijn.',
    category: 'service',
    unit: 'days',
    direction: 'lower-better',
    scope: 'per-store',
    period: 'week',
    icon: 'package',
    source: { type: 'function', fetcher: 'online-warehouse-speed' },
    thresholds: { warn: 1.5, danger: 2.0 },
    hasTarget: false,
    inReports: ['supplychain', 'region-weekly'],
    enabledByDefault: true,
    tags: ['online', 'urgentie']
  },

  /* ═══════════════════════ KWALITEIT ═══════════════════════ */
  {
    key: 'stock_corrections',
    label: 'Voorraad-correcties',
    description: 'Aantal handmatige voorraad-correcties in periode. Hoog = administratie-issues.',
    category: 'kwaliteit',
    unit: 'count',
    direction: 'lower-better',
    scope: 'per-store',
    period: 'month',
    icon: 'edit',
    source: { type: 'function', fetcher: 'stock-corrections' },
    thresholds: { warn: 20, danger: 50 },
    hasTarget: false,
    inReports: ['supplychain'],
    enabledByDefault: true,
    tags: ['winkel', 'kwaliteit']
  },
  {
    key: 'unavailable_lines',
    label: 'Niet-leverbare regels',
    description: '% orderregels dat als niet-leverbaar wordt gemeld in periode.',
    category: 'kwaliteit',
    unit: 'pct',
    direction: 'lower-better',
    scope: 'per-store',
    period: 'week',
    icon: 'x-circle',
    source: { type: 'function', fetcher: 'unavailable-lines' },
    thresholds: { warn: 3, danger: 7 },
    hasTarget: false,
    inReports: ['region-weekly', 'omnichannel'],
    enabledByDefault: true,
    tags: ['kwaliteit']
  },

  /* ═══════════════════════ COMPOSITE ═══════════════════════ */
  {
    key: 'omnichannel_score',
    label: 'Omnichannel-score',
    description: 'Composite 0-100. Combinatie van omzet, klantinschrijvingen, voucher-inwisseling, SRS-data en service. Zie lib/business-config.js → omnichannelScoring.',
    category: 'composite',
    unit: 'score',
    direction: 'higher-better',
    scope: 'per-store',
    period: 'month',
    icon: 'award',
    source: { type: 'composite', fetcher: 'omnichannel-score' },
    thresholds: { warn: 70, danger: 50 },
    hasTarget: false,
    inReports: ['omnichannel', 'trophy-cabinet'],
    enabledByDefault: true,
    tags: ['winkel', 'composite']
  }
];

/* ──────────────────────────────────────────────────────────────────────
 * Cache helpers — voorkomen dat elke read het blob aanraakt.
 * ────────────────────────────────────────────────────────────────────── */

let _cache = null;
let _cacheAt = 0;

function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

/* ──────────────────────────────────────────────────────────────────────
 * Lees-helpers
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Returnt de complete KPI-config = DEFAULT_KPIS + blob-overrides per KPI.
 *
 * Override-velden per KPI: { enabled, label, thresholds, inReports }.
 * De `source`, `category`, `unit`, etc kun je NIET via override aanpassen
 * (die hangen aan de fetcher-implementatie). Wel het label en de drempels.
 *
 * @returns {Promise<{kpis: Array, updatedAt: string|null, updatedBy: string|null}>}
 */
export async function readKpiRegistry({ forceFresh = false } = {}) {
  const now = Date.now();
  if (!forceFresh && _cache && (now - _cacheAt) < READ_CACHE_TTL_MS) {
    return _cache;
  }
  const data = await readJsonBlob(CONFIG_PATH, {
    overrides: {},
    targets: {},
    reportBindings: {},
    updatedAt: null,
    updatedBy: null
  });
  const overrides = data.overrides || {};
  const merged = DEFAULT_KPIS.map((def) => {
    const ov = overrides[def.key] || {};
    return {
      ...def,
      label: ov.label ?? def.label,
      enabled: ov.enabled !== false && def.enabledByDefault !== false,
      thresholds: { ...def.thresholds, ...(ov.thresholds || {}) },
      inReports: Array.isArray(ov.inReports) ? ov.inReports : def.inReports,
      _hasOverride: Object.keys(ov).length > 0
    };
  });
  const result = {
    kpis: merged,
    /* Per-rapport KPI-bindings — wint van DEFAULT_KPIS.inReports[] indien aanwezig.
       Format: { [reportKey]: ['kpiKey1', 'kpiKey2', ...] } */
    reportBindings: data.reportBindings || {},
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null
  };
  _cache = result;
  _cacheAt = now;
  return result;
}

/**
 * Single-KPI lookup — voor fetcher-routing.
 * @param {string} key
 * @returns {Promise<Object|null>}
 */
export async function getKpiByKey(key) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return null;
  const reg = await readKpiRegistry();
  return reg.kpis.find((k) => k.key === cleanKey) || null;
}

/**
 * Returnt enkel de KPI's die in een specifiek rapport-binding moeten verschijnen.
 * Gebruik dit in rapport-renderers om de KPI-lijst dynamisch te bepalen.
 *
 * Resolutie-volgorde:
 *   1. Per-rapport override uit blob `reportBindings[reportKey]` → expliciete lijst (winning)
 *   2. Fallback: KPI's waarvan `inReports[]` deze reportKey bevat
 *
 * Volgorde van resultaat:
 *   - Bij override: in dezelfde volgorde als de geconfigureerde keys
 *   - Bij fallback: in DEFAULT_KPIS volgorde (zoals registry)
 *
 * @param {string} reportKey   bv. 'customer-weekly', 'region-weekly', 'omnichannel'
 * @param {boolean} onlyEnabled (default true) filter uitgeschakelde KPI's
 */
export async function listKpisForReport(reportKey, { onlyEnabled = true } = {}) {
  const reg = await readKpiRegistry();
  const cleanKey = String(reportKey || '').trim();
  if (!cleanKey) return [];

  /* 1. Per-rapport override wint */
  const override = reg.reportBindings?.[cleanKey];
  if (Array.isArray(override) && override.length) {
    const kpiByKey = new Map(reg.kpis.map((k) => [k.key, k]));
    const out = [];
    for (const key of override) {
      const kpi = kpiByKey.get(key);
      if (!kpi) continue;
      if (onlyEnabled && !kpi.enabled) continue;
      out.push(kpi);
    }
    return out;
  }

  /* 2. Fallback: KPI's met inReports[] match */
  return reg.kpis.filter((k) => {
    if (onlyEnabled && !k.enabled) return false;
    return Array.isArray(k.inReports) && k.inReports.includes(cleanKey);
  });
}

/**
 * Returnt alle bindings + welke rapport-keys er momenteel zijn (uit override
 * blob + de inReports[] arrays van DEFAULT_KPIS). Voor admin-UI zodat we de
 * lijst van bekende reports kunnen tonen.
 *
 * @returns {Promise<{bindings: Object, knownReportKeys: string[]}>}
 */
export async function listReportBindings() {
  const reg = await readKpiRegistry();
  const knownFromKpis = new Set();
  for (const k of reg.kpis) {
    (k.inReports || []).forEach((r) => knownFromKpis.add(r));
  }
  for (const r of Object.keys(reg.reportBindings || {})) {
    knownFromKpis.add(r);
  }
  return {
    bindings: reg.reportBindings || {},
    knownReportKeys: [...knownFromKpis].sort()
  };
}

/**
 * Schrijf de KPI-binding voor 1 rapport. Lege array betekent: rapport krijgt
 * GEEN KPI's. Om terug te vallen op DEFAULT_KPIS.inReports → gebruik
 * deleteReportBinding().
 *
 * @param {string} reportKey
 * @param {string[]} kpiKeys  array van KPI-keys (volgorde wordt gerespecteerd)
 * @param {string} actor      audit-actor
 */
export async function setReportBinding(reportKey, kpiKeys, actor = 'admin') {
  const cleanKey = String(reportKey || '').trim();
  if (!cleanKey) throw new Error('reportKey is verplicht.');
  if (!Array.isArray(kpiKeys)) throw new Error('kpiKeys moet een array zijn.');

  /* Validatie: alleen bestaande KPI-keys accepteren */
  const validKeys = new Set(DEFAULT_KPIS.map((k) => k.key));
  const cleanKpis = kpiKeys
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .filter((k, idx, arr) => arr.indexOf(k) === idx) /* dedupe, behoud volgorde */
    .filter((k) => validKeys.has(k));

  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, targets: {}, reportBindings: {} });
  const bindings = data.reportBindings || {};
  bindings[cleanKey] = cleanKpis;

  await writeJsonBlob(CONFIG_PATH, {
    ...data,
    reportBindings: bindings,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  });
  invalidateCache();
  return cleanKpis;
}

/**
 * Verwijder de binding voor 1 rapport → terugvallen op DEFAULT_KPIS.inReports.
 *
 * @param {string} reportKey
 * @param {string} actor
 * @returns {Promise<boolean>}  true als er iets is verwijderd
 */
export async function deleteReportBinding(reportKey, actor = 'admin') {
  const cleanKey = String(reportKey || '').trim();
  if (!cleanKey) return false;
  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, targets: {}, reportBindings: {} });
  const bindings = data.reportBindings || {};
  if (!(cleanKey in bindings)) return false;
  delete bindings[cleanKey];
  await writeJsonBlob(CONFIG_PATH, {
    ...data,
    reportBindings: bindings,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  });
  invalidateCache();
  return true;
}

/* ──────────────────────────────────────────────────────────────────────
 * Schrijf-helpers (admin-API)
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Update override voor 1 KPI. Alleen toegestane velden worden opgeslagen
 * (rest negeren we — anders kan een admin de category/unit slopen).
 *
 * @param {string} key       KPI-key
 * @param {Object} patch     { enabled?, label?, thresholds?, inReports? }
 * @param {string} actor     wie deze wijziging maakt (voor audit-trail)
 */
export async function updateKpiOverride(key, patch = {}, actor = 'admin') {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) throw new Error('KPI-key is verplicht.');
  if (!DEFAULT_KPIS.find((k) => k.key === cleanKey)) {
    throw new Error(`Onbekende KPI: ${cleanKey}`);
  }

  /* Whitelist toegestane override-velden */
  const allowed = {};
  if (typeof patch.enabled === 'boolean') allowed.enabled = patch.enabled;
  if (typeof patch.label === 'string' && patch.label.trim()) allowed.label = patch.label.trim();
  if (patch.thresholds && typeof patch.thresholds === 'object') {
    const t = {};
    if (patch.thresholds.warn === null || Number.isFinite(Number(patch.thresholds.warn))) {
      t.warn = patch.thresholds.warn === null ? null : Number(patch.thresholds.warn);
    }
    if (patch.thresholds.danger === null || Number.isFinite(Number(patch.thresholds.danger))) {
      t.danger = patch.thresholds.danger === null ? null : Number(patch.thresholds.danger);
    }
    if (Object.keys(t).length) allowed.thresholds = t;
  }
  if (Array.isArray(patch.inReports)) {
    allowed.inReports = [...new Set(patch.inReports.map((r) => String(r || '').trim()).filter(Boolean))];
  }

  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, targets: {}, reportBindings: {} });
  const overrides = data.overrides || {};
  overrides[cleanKey] = {
    ...(overrides[cleanKey] || {}),
    ...allowed,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  };

  await writeJsonBlob(CONFIG_PATH, {
    ...data,
    overrides,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  });
  invalidateCache();
  return readKpiRegistry({ forceFresh: true });
}

/**
 * Reset override voor 1 KPI naar default.
 */
export async function resetKpiOverride(key, actor = 'admin') {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return false;
  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, targets: {}, reportBindings: {} });
  const overrides = data.overrides || {};
  if (!(cleanKey in overrides)) return false;
  delete overrides[cleanKey];
  await writeJsonBlob(CONFIG_PATH, {
    ...data,
    overrides,
    updatedAt: new Date().toISOString(),
    updatedBy: actor
  });
  invalidateCache();
  return true;
}

/* ──────────────────────────────────────────────────────────────────────
 * Categorieën — handig voor UI-grouping
 * ────────────────────────────────────────────────────────────────────── */

export const KPI_CATEGORIES = Object.freeze({
  financieel:  { label: 'Financieel',  icon: 'money',         color: 'green' },
  volume:      { label: 'Volume',      icon: 'shopping-bag',  color: 'blue' },
  customer:    { label: 'Klant',       icon: 'user-plus',     color: 'pink' },
  service:     { label: 'Service',     icon: 'clock',         color: 'amber' },
  kwaliteit:   { label: 'Kwaliteit',   icon: 'check-circle',  color: 'purple' },
  composite:   { label: 'Composite',   icon: 'award',         color: 'indigo' }
});

export const KPI_UNITS = Object.freeze({
  eur:     { label: 'Euro',           symbol: '€',  formatter: (v) => '€ ' + Number(v).toLocaleString('nl-NL', { maximumFractionDigits: 0 }) },
  count:   { label: 'Aantal',         symbol: '',   formatter: (v) => Number(v).toLocaleString('nl-NL') },
  pct:     { label: 'Procent',        symbol: '%',  formatter: (v) => Number(v).toFixed(1).replace('.', ',') + ' %' },
  days:    { label: 'Dagen',          symbol: 'd',  formatter: (v) => Number(v).toFixed(1).replace('.', ',') + ' d' },
  minutes: { label: 'Minuten',        symbol: 'm',  formatter: (v) => Math.round(Number(v)) + ' min' },
  score:   { label: 'Score 0-100',    symbol: '',   formatter: (v) => Math.round(Number(v)).toString() }
});

/**
 * Format een waarde volgens de KPI-unit. Veilig bij null/NaN.
 */
export function formatKpiValue(value, unit) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '–';
  const u = KPI_UNITS[unit];
  if (!u) return String(value);
  return u.formatter(value);
}

/**
 * Returnt 'ok' | 'warn' | 'danger' op basis van thresholds + direction.
 * Direction 'higher-better':  warn = lager dan target,  danger = nog lager
 * Direction 'lower-better':   warn = hoger dan target,  danger = nog hoger
 */
export function gradeKpiValue(value, kpi) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return 'unknown';
  const v = Number(value);
  const t = kpi.thresholds || {};
  if (kpi.direction === 'lower-better') {
    if (t.danger != null && v >= Number(t.danger)) return 'danger';
    if (t.warn   != null && v >= Number(t.warn))   return 'warn';
    return 'ok';
  }
  /* higher-better */
  if (t.danger != null && v <= Number(t.danger)) return 'danger';
  if (t.warn   != null && v <= Number(t.warn))   return 'warn';
  return 'ok';
}

export default {
  DEFAULT_KPIS,
  KPI_CATEGORIES,
  KPI_UNITS,
  readKpiRegistry,
  getKpiByKey,
  listKpisForReport,
  listReportBindings,
  setReportBinding,
  deleteReportBinding,
  updateKpiOverride,
  resetKpiOverride,
  formatKpiValue,
  gradeKpiValue
};
