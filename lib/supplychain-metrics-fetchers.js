/**
 * Per-metric data-fetchers voor de supplychain snapshot-cron.
 *
 * Elke fetcher krijgt { branchId, store, dateStr } en geeft een Number terug
 * (of null als data niet beschikbaar is — dan blijft de dag-cell leeg).
 *
 * Status v1:
 *   - sales, stock-value, negative-stock, weborders   → live data uit bestaande caches
 *   - exchanges, corrections, lost-found,
 *     replenishments, inventarisaties                  → placeholder (return 0)
 *     reden: SRS movement-API integratie staat nog op de roadmap. Frontend toont
 *     deze metrics als '—' met info-tooltip "data nog niet aangesloten".
 *
 * Reliability-score wordt afgeleid uit andere metrics na collect (in cron-handler).
 */

import { readBranchRevenue } from './srs-revenue-cache-store.js';
import { readBranchSnapshot } from './srs-stock-snapshot-store.js';

const TODO_PLACEHOLDER = null; /* null = "data nog niet aangesloten" — frontend toont '—' */

/* ─── Verkoop (uit revenue-cache) ───────────────────────────────────── */
async function fetchSales({ branchId, dateStr }) {
  try {
    const data = await readBranchRevenue(branchId);
    const day = data?.days?.[dateStr];
    if (!day) return 0;
    return Number(day.itemsSold || 0);
  } catch (e) {
    console.warn('[supplychain.fetchSales]', branchId, e.message);
    return 0;
  }
}

/* ─── Weborders (uit revenue-cache transactionCount als proxy) ──────── */
async function fetchWeborders({ branchId, dateStr }) {
  try {
    const data = await readBranchRevenue(branchId);
    const day = data?.days?.[dateStr];
    if (!day) return 0;
    /* Voor v1: transactionCount = aantal kassa-transacties. Real weborders
       komen later uit Shopify orders-by-store. */
    return Number(day.transactionCount || 0);
  } catch (e) {
    console.warn('[supplychain.fetchWeborders]', branchId, e.message);
    return 0;
  }
}

/* ─── Negatieve voorraad (snapshot per branch) ──────────────────────── */
async function fetchNegativeStock({ branchId }) {
  try {
    const snap = await readBranchSnapshot(branchId);
    if (!snap) return 0;
    return (snap.rows || []).filter((r) => Number(r.pieces || 0) < 0).length;
  } catch (e) {
    console.warn('[supplychain.fetchNegativeStock]', branchId, e.message);
    return 0;
  }
}

/* ─── Financiële voorraad (stuks × unitPrice) ───────────────────────── */
async function fetchStockValue({ branchId }) {
  try {
    const snap = await readBranchSnapshot(branchId);
    if (!snap) return 0;
    const total = (snap.rows || []).reduce((sum, r) => {
      const pieces = Math.max(0, Number(r.pieces || 0));
      const price = Number(r.unitPrice || r.price || 0);
      return sum + pieces * price;
    }, 0);
    return Math.round(total * 100) / 100;
  } catch (e) {
    console.warn('[supplychain.fetchStockValue]', branchId, e.message);
    return 0;
  }
}

/* ─── Composite: reliability-score ───────────────────────────────────
   Score = 100 × (1 - (correcties + negatief + lost&found) / max(verkoop + weborders, 1))
   Begrensd op [0, 100]. Hoger = beter.
*/
function computeReliabilityScore(metrics) {
  const issues = Number(metrics['corrections'] || 0)
    + Number(metrics['negative-stock'] || 0)
    + Number(metrics['lost-found'] || 0);
  const volume = Math.max(1, Number(metrics['sales'] || 0) + Number(metrics['weborders'] || 0));
  const ratio = issues / volume;
  const score = 100 * Math.max(0, Math.min(1, 1 - ratio));
  return Math.round(score * 10) / 10;
}

/* ─── Fetcher registry ──────────────────────────────────────────────── */

export const FETCHERS = {
  'sales': fetchSales,
  'weborders': fetchWeborders,
  'negative-stock': fetchNegativeStock,
  'stock-value': fetchStockValue,
  /* Placeholders — return TODO_PLACEHOLDER (= null), dashboard toont '—' */
  'replenishments': async () => TODO_PLACEHOLDER,
  'corrections': async () => TODO_PLACEHOLDER,
  'lost-found': async () => TODO_PLACEHOLDER,
  'inventarisaties': async () => TODO_PLACEHOLDER
};

/**
 * Bereken alle metrics voor één filiaal × datum.
 * Reliability-score wordt afgeleid na collect.
 */
export async function computeMetricsForBranch(metricDefs, ctx) {
  const out = {};
  for (const m of metricDefs) {
    if (m.key === 'reliability-score') continue; /* derived */
    const fn = FETCHERS[m.key];
    if (typeof fn !== 'function') { out[m.key] = TODO_PLACEHOLDER; continue; }
    try {
      out[m.key] = await fn(ctx);
    } catch (e) {
      console.warn(`[supplychain.${m.key}] fail:`, e.message);
      out[m.key] = TODO_PLACEHOLDER;
    }
  }
  /* Reliability-score: alleen berekenen als kerncomponenten bekend zijn */
  if (metricDefs.find((m) => m.key === 'reliability-score')) {
    /* Null-safe: ontbrekende metric → 0 voor de score-berekening (placeholder zonder data) */
    const safeMetrics = Object.fromEntries(
      Object.entries(out).map(([k, v]) => [k, v == null ? 0 : v])
    );
    out['reliability-score'] = computeReliabilityScore(safeMetrics);
  }
  return out;
}
