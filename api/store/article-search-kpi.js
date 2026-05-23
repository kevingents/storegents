import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { readBranchSnapshot } from '../../lib/srs-stock-snapshot-store.js';
import { listAllBranches } from '../../lib/branch-metrics.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';

/**
 * GET /api/store/article-search-kpi
 *
 * Geaggregeerde voorraad-KPI's voor het beginscherm van de Voorraad-zoeker:
 *   - total       totaal aantal unieke artikelen in Shopify (alle varianten)
 *   - available   varianten met ≥1 stuk in een willekeurige winkel
 *   - lastPieces  varianten met 1 of 2 stuks totaal (laatste stuks)
 *   - outOfStock  varianten met 0 stuks overal
 *
 * Berekening gebaseerd op SRS branch-snapshots geaggregeerd per barcode/sku.
 * Cache 5 min in-memory om herhaalde dashboard-calls niet steeds te
 * herberekenen (volle scan van 20+ branches is duur).
 *
 * Public endpoint — winkel-medewerkers gebruiken dit ook vanaf POS.
 */

const CACHE_TTL_MS = 5 * 60 * 1000;
let __MEM_CACHE__ = { at: 0, data: null };

function lower(v) { return String(v || '').trim().toLowerCase(); }

async function computeKpis() {
  /* Pak alle SRS branch-snapshots parallel */
  const branches = listAllBranches();
  const snapshots = await Promise.all(branches.map(async (b) => {
    try { return { branchId: b.branchId, snap: await readBranchSnapshot(b.branchId) }; }
    catch { return { branchId: b.branchId, snap: null }; }
  }));

  /* Aggregeer per unieke artikel-key (barcode of sku) over alle branches */
  const pieceMap = new Map(); /* key → totalPieces */
  for (const { snap } of snapshots) {
    if (!snap?.rows?.length) continue;
    for (const r of snap.rows) {
      const key = lower(r.barcode || r.sku || r.articleNumber);
      if (!key) continue;
      pieceMap.set(key, (pieceMap.get(key) || 0) + Number(r.pieces || 0));
    }
  }

  /* Totaal Shopify varianten — uit cache */
  let totalVariants = 0;
  try {
    const cache = await readProductsCache();
    totalVariants = Number(cache.variantCount || Object.keys(cache.byBarcode || {}).length || 0);
  } catch (_e) { /* skip */ }

  let available = 0;
  let lastPieces = 0;
  let outOfStock = 0;
  for (const total of pieceMap.values()) {
    if (total === 0) outOfStock += 1;
    else {
      available += 1;
      if (total <= 2) lastPieces += 1;
    }
  }

  /* total = max van Shopify-varianten (cache) of SRS-rows (snapshots).
     Shopify is meestal hoger want sommige varianten staan niet in SRS-snapshots. */
  const total = Math.max(totalVariants, pieceMap.size);

  return { total, available, lastPieces, outOfStock };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    if (__MEM_CACHE__.data && (Date.now() - __MEM_CACHE__.at) < CACHE_TTL_MS) {
      return res.status(200).json({ success: true, ...__MEM_CACHE__.data, cached: true });
    }
    const data = await computeKpis();
    __MEM_CACHE__ = { at: Date.now(), data };
    return res.status(200).json({ success: true, ...data, cached: false, generatedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[article-search-kpi]', error);
    return res.status(500).json({ success: false, message: error.message || 'KPI-berekening mislukt.' });
  }
}
