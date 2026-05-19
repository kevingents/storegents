/**
 * GET /api/google-reviews/region-compare?store=GENTS Den Bosch
 *
 * Vergelijkt deze winkel met andere winkels in dezelfde regio (en algehele
 * GENTS-gemiddelde). Gebruikt de cached "all" payload van het summary
 * endpoint zodat we niet opnieuw alle winkels hoeven op te halen.
 *
 * Response:
 *   {
 *     thisStore: { store, rating, reviewCount },
 *     regionAvg: number,
 *     regionWinkels: [...],
 *     gentsAvg: number,
 *     rank: { inRegion: 2, ofRegion: 5, inGents: 8, ofGents: 22 }
 *   }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { listBranches, getBranchIdByStore } from '../../lib/branch-metrics.js';
import { getGoogleReviewsForStore } from '../../lib/google-reviews-client.js';
import { getRegionReportConfig, getRegionForStore } from '../../lib/region-report-config-store.js';

const CACHE_TTL_MS = 30 * 60 * 1000; /* 30 min */
const cache = new Map();

function clean(value) { return String(value || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = clean(req.query.store);
  if (!store) return res.status(400).json({ success: false, message: 'store is verplicht.' });

  /* Cache: 1 entry voor alle stores tegelijk (vermijdt N x lookup) */
  const cacheKey = 'all-stores';
  let allRows;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    allRows = cached.rows;
  } else {
    try {
      const branches = listBranches();
      const rows = await Promise.all(branches.map(async (branch) => {
        try {
          const r = await getGoogleReviewsForStore({ store: branch.store, branchId: branch.branchId });
          return {
            store: branch.store,
            branchId: branch.branchId,
            rating: Number(r.rating || 0),
            reviewCount: Number(r.reviewCount || 0)
          };
        } catch (_e) {
          return { store: branch.store, branchId: branch.branchId, rating: 0, reviewCount: 0 };
        }
      }));
      cache.set(cacheKey, { rows, at: Date.now() });
      allRows = rows;
    } catch (error) {
      return res.status(500).json({ success: false, message: error.message || 'All-stores fetch mislukt.' });
    }
  }

  /* Filter: alleen winkels met rating > 0 voor zinvolle vergelijking */
  const ratedRows = allRows.filter((r) => r.rating > 0);

  /* Regio bepalen */
  let regionRows = [];
  let regionName = '';
  try {
    const regionConfig = await getRegionReportConfig();
    const region = getRegionForStore(regionConfig, store);
    if (region) {
      regionName = region.name || '';
      const regionStoreSet = new Set(region.stores || []);
      regionRows = ratedRows.filter((r) => regionStoreSet.has(r.store));
    }
  } catch (_e) { /* regio-config faalt → skip regio */ }

  /* Bereken statistieken */
  const thisStore = ratedRows.find((r) => r.store === store) || allRows.find((r) => r.store === store) || { store, rating: 0, reviewCount: 0 };
  const regionAvg = regionRows.length ? regionRows.reduce((sum, r) => sum + r.rating, 0) / regionRows.length : 0;
  const gentsAvg = ratedRows.length ? ratedRows.reduce((sum, r) => sum + r.rating, 0) / ratedRows.length : 0;

  /* Rangschikking */
  const sortedRegion = regionRows.slice().sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
  const sortedGents = ratedRows.slice().sort((a, b) => b.rating - a.rating || b.reviewCount - a.reviewCount);
  const inRegion = sortedRegion.findIndex((r) => r.store === store) + 1 || null;
  const inGents = sortedGents.findIndex((r) => r.store === store) + 1 || null;

  /* Top 3 + bottom 3 in regio voor context */
  const top3Region = sortedRegion.slice(0, 3);
  const bottomRegion = sortedRegion.length >= 3 ? sortedRegion.slice(-3).reverse() : [];

  return res.status(200).json({
    success: true,
    thisStore,
    regionName,
    regionAvg: Math.round(regionAvg * 100) / 100,
    gentsAvg: Math.round(gentsAvg * 100) / 100,
    regionWinkels: regionRows,
    rank: {
      inRegion,
      ofRegion: regionRows.length,
      inGents,
      ofGents: ratedRows.length
    },
    top3Region,
    bottomRegion,
    delta: {
      vsRegion: Math.round((thisStore.rating - regionAvg) * 100) / 100,
      vsGents: Math.round((thisStore.rating - gentsAvg) * 100) / 100
    }
  });
}
