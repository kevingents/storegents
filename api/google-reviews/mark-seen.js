/**
 * POST /api/google-reviews/mark-seen
 * Body: { store, reviewIds: ['id1','id2',...] | 'all' }
 *
 * Markeer een set Google-review-IDs als gezien voor deze winkel zodat de
 * 'Nieuw' badge verdwijnt bij volgende ophaal.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { markReviewsSeen, flagNewReviews } from '../../lib/google-reviews-seen-store.js';
import { getGoogleReviewsForStore } from '../../lib/google-reviews-client.js';
import { getBranchIdByStore } from '../../lib/branch-metrics.js';

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  const body = parseBody(req);
  const store = String(body.store || '').trim();
  if (!store) return res.status(400).json({ success: false, message: 'store is verplicht.' });

  try {
    let ids = [];
    if (body.reviewIds === 'all') {
      /* Haal huidige reviews op en markeer alle IDs */
      const branchId = getBranchIdByStore(store) || '';
      const result = await getGoogleReviewsForStore({ store, branchId });
      const flagged = await flagNewReviews(store, result.reviews || []);
      ids = flagged.map((r) => r.derivedId).filter(Boolean);
    } else if (Array.isArray(body.reviewIds)) {
      ids = body.reviewIds;
    } else {
      return res.status(400).json({ success: false, message: 'reviewIds array of "all" verplicht.' });
    }

    const result = await markReviewsSeen(store, ids);
    return res.status(200).json({ success: true, store, ...result });
  } catch (error) {
    console.error('[google-reviews/mark-seen]', error);
    return res.status(500).json({ success: false, message: error.message || 'Mark-seen mislukt.' });
  }
}
