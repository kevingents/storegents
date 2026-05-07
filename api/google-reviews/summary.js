import { listBranches, getBranchIdByStore } from '../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getGoogleReviewsForStore, findGooglePlace } from '../../lib/google-reviews-client.js';

const CACHE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.GOOGLE_REVIEWS_CACHE_MS || 60 * 60 * 1000) || 60 * 60 * 1000
);

const SOURCE_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.GOOGLE_REVIEWS_TIMEOUT_MS || 10000) || 10000
);

const ALL_CONCURRENCY = Math.max(
  1,
  Number(process.env.GOOGLE_REVIEWS_ALL_CONCURRENCY || 4) || 4
);

const reviewCache = new Map();

function bool(value) {
  return ['1', 'true', 'yes', 'ja'].includes(String(value || '').trim().toLowerCase());
}

function pickStore(req) {
  return String(req.query.store || req.query.branchName || '').trim();
}

function pickBranchId(req, store) {
  return String(req.query.branchId || getBranchIdByStore(store) || '').trim();
}

function cacheKeyFor({ store, branchId, all, lookup }) {
  return `${all ? 'all' : store || branchId || 'single'}|${branchId || ''}|lookup:${lookup ? '1' : '0'}`;
}

function getCached(key) {
  const cached = reviewCache.get(key);
  if (!cached) return null;
  if (Date.now() - cached.createdAt > CACHE_TTL_MS) {
    reviewCache.delete(key);
    return null;
  }
  return cached.payload;
}

function setCached(key, payload) {
  reviewCache.set(key, { createdAt: Date.now(), payload });
  if (reviewCache.size > 100) reviewCache.delete(reviewCache.keys().next().value);
}

async function runLimited(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function runner() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runner())
  );

  return results;
}

function toPublicRow(result, extra = {}) {
  return {
    success: true,
    store: result.store || extra.store || '',
    branchId: result.branchId || extra.branchId || '',
    placeId: result.placeId || '',
    name: result.name || '',
    address: result.address || '',
    businessStatus: result.businessStatus || '',
    rating: result.rating || 0,
    score: result.rating || 0,
    reviewCount: result.reviewCount || 0,
    count: result.reviewCount || 0,
    userRatingsTotal: result.userRatingsTotal || result.reviewCount || 0,
    googleMapsUrl: result.googleMapsUrl || '',
    source: result.source || 'Google Places',
    updatedAt: new Date().toISOString(),
    reviews: result.reviews || [],
    reviewsList: result.reviews || [],
    latestReviews: result.reviews || [],
    reviewLimitNote: result.reviewLimitNote || ''
  };
}

async function loadSingle({ store, branchId, placeId, query, includeReviews, allowLookup }) {
  const result = await getGoogleReviewsForStore({
    store,
    branchId,
    placeId,
    query,
    timeoutMs: SOURCE_TIMEOUT_MS,
    allowLookup
  });

  const row = toPublicRow(result, { store, branchId });

  if (!includeReviews) {
    row.reviews = [];
    row.reviewsList = [];
    row.latestReviews = [];
  }

  return row;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  if (requireAdmin(req, res)) return;

  const all = bool(req.query.all);
  const refresh = bool(req.query.refresh);
  const includeReviews = bool(req.query.includeReviews);
  const allowLookup = bool(req.query.lookup || req.query.allowLookup);
  const store = pickStore(req);
  const branchId = pickBranchId(req, store);
  const placeId = String(req.query.placeId || req.query.place_id || '').trim();
  const query = String(req.query.query || '').trim();
  const cacheKey = cacheKeyFor({ store, branchId, all, lookup: allowLookup });

  if (!refresh) {
    const cached = getCached(cacheKey);
    if (cached) {
      return res.status(200).json({
        ...cached,
        cache: { hit: true, ttlMs: CACHE_TTL_MS }
      });
    }
  }

  try {
    if (bool(req.query.findPlace)) {
      const lookup = await findGooglePlace({ store, branchId, query, timeoutMs: SOURCE_TIMEOUT_MS });
      return res.status(200).json({
        success: true,
        ...toPublicRow(lookup, { store, branchId }),
        cache: { hit: false, ttlMs: CACHE_TTL_MS }
      });
    }

    if (all) {
      const branches = listBranches();
      const rows = await runLimited(branches, ALL_CONCURRENCY, async (branch) => {
        try {
          return await loadSingle({
            store: branch.store,
            branchId: branch.branchId,
            includeReviews,
            allowLookup
          });
        } catch (error) {
          return {
            success: false,
            store: branch.store,
            branchId: branch.branchId,
            rating: 0,
            score: 0,
            reviewCount: 0,
            count: 0,
            source: 'Google Places',
            updatedAt: new Date().toISOString(),
            message: error.message || String(error)
          };
        }
      });

      const payload = {
        success: true,
        rows,
        stores: rows,
        source: 'Google Places',
        updatedAt: new Date().toISOString(),
        cache: { hit: false, ttlMs: CACHE_TTL_MS }
      };

      setCached(cacheKey, payload);
      return res.status(200).json(payload);
    }

    if (!store && !branchId && !placeId && !query) {
      return res.status(400).json({
        success: false,
        message: 'Geef store, branchId, placeId of query mee.'
      });
    }

    const payload = await loadSingle({
      store,
      branchId,
      placeId,
      query,
      includeReviews,
      allowLookup
    });

    payload.cache = { hit: false, ttlMs: CACHE_TTL_MS };
    setCached(cacheKey, payload);
    return res.status(200).json(payload);
  } catch (error) {
    return res.status(200).json({
      success: false,
      store,
      branchId,
      rating: 0,
      score: 0,
      reviewCount: 0,
      count: 0,
      source: 'Google Places',
      updatedAt: new Date().toISOString(),
      message: error.message || 'Google reviews konden niet worden opgehaald.'
    });
  }
}
