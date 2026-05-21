import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getActiveDealsForStore } from '../../lib/vereniging-deals-store.js';

/**
 * GET /api/store/vereniging-deals?store=GENTS+Leiden
 *
 * Geeft actieve deals voor de gegeven winkel (in periode).
 * Geen admin-token nodig — winkel-medewerkers gebruiken dit.
 *
 * Response: { success, store, count, deals: [{ id, vereniging, title, ... }] }
 */

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = clean(req.query.store);
  if (!store) return res.status(400).json({ success: false, message: 'store-parameter ontbreekt.' });

  try {
    const deals = await getActiveDealsForStore(store);
    return res.status(200).json({
      success: true,
      store,
      count: deals.length,
      deals,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[store/vereniging-deals]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Deals kon niet worden opgehaald.'
    });
  }
}
