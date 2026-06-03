/**
 * Supplychain metric-registry.
 *
 * Centrale definitie van de KPI's die het supplychain-dashboard toont.
 * Per metric:
 *   - key        : unieke identifier
 *   - label      : NL display-label
 *   - unit       : 'count' | 'eur' | 'pct' | 'days' | 'score'
 *   - category   : 'volume' | 'kwaliteit' | 'financieel' | 'composite'
 *   - icon       : SVG icon-key uit svgIcon helper (frontend)
 *   - direction  : 'higher-better' of 'lower-better' (voor kleur-coding)
 *   - description: korte uitleg in UI tooltip
 *   - source     : data-bron (alleen documentair — fetchers staan in supplychain-metrics-fetchers.js)
 *   - thresholds : { warn, danger } voor heatmap-kleur. Direction bepaalt richting.
 *   - enabledByDefault: of de metric standaard meedraait
 *   - showInBeheer: of admin het kan aan/uit zetten + drempel kan instellen
 *
 * Overrides per metric (enabled, thresholds, label, beheer-recipients) worden
 * opgeslagen in Blob: admin/supplychain-metrics-config.json en gemerged on-read.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const CONFIG_PATH = 'admin/supplychain-metrics-config.json';

/* ─── Default metric registry ───────────────────────────────────────── */

export const DEFAULT_METRICS = [
  /* ── Volume metrics — wat is er door het filiaal gegaan ── */
  {
    key: 'sales',
    label: 'Verkoop',
    unit: 'count',
    category: 'volume',
    icon: 'shopping-bag',
    direction: 'higher-better',
    description: 'Aantal verkochte stuks via kassa + omzet in periode',
    source: 'srs-revenue-cache',
    thresholds: { warn: null, danger: null },
    enabledByDefault: true,
    showInBeheer: true
  },
  {
    key: 'weborders',
    label: 'Weborders',
    unit: 'count',
    category: 'volume',
    icon: 'package',
    direction: 'higher-better',
    description: 'Aantal weborders gepickt + verzonden in periode',
    source: 'srs-open-weborders + shopify',
    thresholds: { warn: null, danger: null },
    enabledByDefault: true,
    showInBeheer: true
  },
  {
    key: 'replenishments',
    label: 'Aanvullingen',
    unit: 'count',
    category: 'volume',
    icon: 'arrow-down',
    direction: 'higher-better',
    description: 'Stuks ontvangen vanuit centraal magazijn / leverancier',
    source: 'srs-purchase-orders + srs-stock-delta',
    thresholds: { warn: null, danger: null },
    enabledByDefault: true,
    showInBeheer: true
  },

  /* ── Kwaliteit metrics — hoe stevig is de voorraad-administratie ── */
  {
    key: 'corrections',
    label: 'Correcties',
    unit: 'count',
    category: 'kwaliteit',
    icon: 'edit',
    direction: 'lower-better',
    description: 'Handmatige voorraad-correcties — hoog = veel administratie-issues',
    source: 'srs-transactions (correction type)',
    thresholds: { warn: 20, danger: 50 },
    enabledByDefault: true,
    showInBeheer: true
  },
  {
    key: 'negative-stock',
    label: 'Negatieve voorraad',
    unit: 'count',
    category: 'kwaliteit',
    icon: 'alert-triangle',
    direction: 'lower-better',
    description: 'SKU\'s met voorraad <0 — duidt op niet-geregistreerde verkoop of foute correcties',
    source: 'stock-negative-store',
    thresholds: { warn: 5, danger: 15 },
    enabledByDefault: true,
    showInBeheer: true
  },
  {
    key: 'lost-found',
    label: 'Lost & Found',
    unit: 'count',
    category: 'kwaliteit',
    icon: 'search',
    direction: 'lower-better',
    description: 'Aantal Lost & Found meldingen — hoog wijst op shrinkage of zoekgeraakte artikelen',
    source: 'srs-lost-found',
    thresholds: { warn: 3, danger: 8 },
    enabledByDefault: true,
    showInBeheer: true
  },
  {
    key: 'inventarisaties',
    label: 'Inventarisaties',
    unit: 'count',
    category: 'kwaliteit',
    icon: 'list',
    direction: 'higher-better', /* regelmatig inventariseren is goed */
    description: 'Aantal uitgevoerde stock counts in periode',
    source: 'srs-stock-count-records',
    thresholds: { warn: null, danger: null },
    enabledByDefault: true,
    showInBeheer: true
  },

  /* ── Financieel ── */
  {
    key: 'stock-value',
    label: 'Financiële voorraad',
    unit: 'eur',
    category: 'financieel',
    icon: 'money',
    direction: 'higher-better', /* niet per se beter, maar geen warn-drempels in v1 */
    description: 'Totale voorraadwaarde (stuks × inkoopprijs) op periode-einde',
    source: 'srs-stock-snapshot × srs-articles-registry',
    thresholds: { warn: null, danger: null },
    enabledByDefault: true,
    showInBeheer: true
  },

  /* ── Composite KPI ── */
  {
    key: 'reliability-score',
    label: 'Voorraad-betrouwbaarheid',
    unit: 'score', /* 0-100 */
    category: 'composite',
    icon: 'check-circle',
    direction: 'higher-better',
    description: 'Composite score 0-100 = 100 × (1 - (correcties + negatief + lost&found) / max(verkoop+weborders, 1)). 100 = perfect, <70 = aandacht nodig',
    source: 'derived',
    thresholds: { warn: 80, danger: 70 },
    enabledByDefault: true,
    showInBeheer: true
  }
];

/* ─── Beheer-laag (Blob-backed) ─────────────────────────────────────── */

/**
 * Lees gemergde config: defaults + Blob overrides per metric-key.
 *
 * Overrides kunnen velden bevatten: enabled, label, thresholds, alertRecipients[].
 * Niet-overschreven velden behouden de default.
 */
export async function readMetricsConfig() {
  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, alertRecipients: [] });
  const overrides = data.overrides || {};
  const merged = DEFAULT_METRICS.map((m) => {
    const ov = overrides[m.key] || {};
    return {
      ...m,
      ...ov,
      key: m.key, /* key kan niet overschreven worden */
      enabled: ov.enabled !== false && m.enabledByDefault,
      thresholds: { ...m.thresholds, ...(ov.thresholds || {}) },
      alertRecipients: Array.isArray(ov.alertRecipients) ? ov.alertRecipients : []
    };
  });
  return {
    metrics: merged,
    globalAlertRecipients: data.alertRecipients || [],
    updatedAt: data.updatedAt || null
  };
}

/**
 * Update één metric (alleen overrides — defaults blijven in code).
 *
 * @param {string} key       metric-key
 * @param {Object} patch     velden: enabled, label, thresholds, alertRecipients
 */
export async function updateMetricOverride(key, patch = {}) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) throw new Error('metric-key is verplicht');
  if (!DEFAULT_METRICS.find((m) => m.key === cleanKey)) {
    throw new Error(`Onbekende metric-key: ${cleanKey}`);
  }
  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, alertRecipients: [] });
  const overrides = data.overrides || {};
  const existing = overrides[cleanKey] || {};
  overrides[cleanKey] = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(CONFIG_PATH, { ...data, overrides, updatedAt: new Date().toISOString() });
  return readMetricsConfig();
}

/**
 * Update globale alert-recipients (mailadressen die bij overschrijding altijd CC krijgen).
 */
export async function updateGlobalAlertRecipients(recipients = []) {
  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, alertRecipients: [] });
  const clean = Array.isArray(recipients)
    ? [...new Set(recipients.map((r) => String(r || '').trim()).filter(Boolean))]
    : [];
  await writeJsonBlob(CONFIG_PATH, {
    ...data,
    alertRecipients: clean,
    updatedAt: new Date().toISOString()
  });
  return readMetricsConfig();
}

/**
 * Reset één metric naar default (verwijder override).
 */
export async function resetMetricOverride(key) {
  const cleanKey = String(key || '').trim();
  if (!cleanKey) return false;
  const data = await readJsonBlob(CONFIG_PATH, { overrides: {}, alertRecipients: [] });
  const overrides = data.overrides || {};
  if (!(cleanKey in overrides)) return false;
  delete overrides[cleanKey];
  await writeJsonBlob(CONFIG_PATH, { ...data, overrides, updatedAt: new Date().toISOString() });
  return true;
}
