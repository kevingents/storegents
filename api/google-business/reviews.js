import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { listBranches, getBranchIdByStore } from '../../lib/branch-metrics.js';
import { listBusinessReviews } from '../../lib/google-business-profile-client.js';

const ALL_CONCURRENCY = Math.max(1, Number(process.env.GOOGLE_BUSINESS_REVIEWS_ALL_CONCURRENCY || 3) || 3);

function bool(value) {
  return ['1', 'true', 'yes', 'ja'].includes(String(value || '').trim().toLowerCase());
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
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => runner()));
  return results;
}

function toPublicRow(result, { includeReviews = false } = {}) {
  return {
    success: true,
    store: result.store || '',
    branchId: result.branchId || '',
    locationId: result.locationId || '',
    rating: result.rating || result.averageRating || 0,
    score: result.rating || result.averageRating || 0,
    reviewCount: result.reviewCount || result.totalReviewCount || 0,
    count: result.reviewCount || result.totalReviewCount || 0,
    totalReviewCount: result.totalReviewCount || result.reviewCount || 0,
    source: result.source || 'Google Business Profile',
    updatedAt: result.updatedAt || new Date().toISOString(),
    reviews: includeReviews ? (result.reviews || []) : [],
    reviewsList: includeReviews ? (result.reviews || []) : [],
    latestReviews: includeReviews ? (result.reviews || []) : []
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const all = bool(req.query.all);
  const includeReviews = bool(req.query.includeReviews);
  const store = String(req.query.store || req.query.branchName || '').trim();
  const branchId = String(req.query.branchId || getBranchIdByStore(store) || '').trim();
  const locationId = String(req.query.locationId || req.query.location_id || '').trim();
  const pageSize = Math.min(50, Math.max(1, Number(req.query.pageSize || (includeReviews ? 20 : 5))));
  const pageToken = String(req.query.pageToken || '').trim();

  try {
    if (all) {
      const branches = listBranches();
      const rows = await runLimited(branches, ALL_CONCURRENCY, async (branch) => {
        try {
          const result = await listBusinessReviews({
            store: branch.store,
            branchId: branch.branchId,
            pageSize,
            pageToken: ''
          });
          return toPublicRow(result, { includeReviews });
        } catch (error) {
          return {
            success: false,
            store: branch.store,
            branchId: branch.branchId,
            rating: 0,
            score: 0,
            reviewCount: 0,
            count: 0,
            source: 'Google Business Profile',
            updatedAt: new Date().toISOString(),
            message: error.message || String(error)
          };
        }
      });
      return res.status(200).json({ success: true, source: 'Google Business Profile', rows, stores: rows, updatedAt: new Date().toISOString() });
    }

    if (!store && !branchId && !locationId) {
      return res.status(400).json({ success: false, message: 'Geef store, branchId of locationId mee.' });
    }

    const result = await listBusinessReviews({ store, branchId, locationId, pageSize, pageToken });
    return res.status(200).json({ ...toPublicRow(result, { includeReviews: true }), nextPageToken: result.nextPageToken || '' });
  } catch (error) {
    return res.status(200).json({
      success: false,
      store,
      branchId,
      locationId,
      rating: 0,
      score: 0,
      reviewCount: 0,
      count: 0,
      source: 'Google Business Profile',
      updatedAt: new Date().toISOString(),
      message: error.message || 'Google Business reviews konden niet worden opgehaald.'
    });
  }
}
