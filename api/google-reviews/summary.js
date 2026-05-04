import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { safeJson } from '../../lib/branch-metrics.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=3600');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  const store = String(req.query.store || '').trim();
  const reviews = safeJson(process.env.GOOGLE_REVIEW_SCORES_JSON, {});
  const fallback = { rating: null, count: null, url: '', source: 'placeholder' };
  const row = reviews[store] || fallback;

  return res.status(200).json({
    success: true,
    store,
    rating: row.rating ?? null,
    count: row.count ?? null,
    url: row.url || '',
    source: row.source || 'env-json',
    message: row.rating ? 'Google review score geladen.' : 'Nog geen Google review score ingesteld voor deze winkel.'
  });
}
