import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readDragersHistory, computeDragersHistoryStats } from '../../lib/srs-dragers-history-store.js';

/**
 * GET /api/admin/dragers-history
 *   ?from=YYYY-MM-DD  (default = 90 dagen geleden)
 *   ?to=YYYY-MM-DD    (default = vandaag)
 *   ?store=GENTS Tilburg  (optioneel — filter op bestemming-winkel)
 *   ?onlyLate=1       (optioneel — alleen te-late dragers)
 *   ?limit=200        (default 200, max 1000)
 *
 * Returnt afgesloten dragers + per-store statistieken.
 */

export const maxDuration = 20;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  try {
    const { closed, updatedAt } = await readDragersHistory();

    const defaultFrom = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
    const from = String(req.query.from || defaultFrom).trim();
    const to = String(req.query.to || new Date().toISOString().slice(0, 10)).trim();
    const storeFilter = String(req.query.store || '').trim();
    const onlyLate = ['1', 'true'].includes(String(req.query.onlyLate || '').toLowerCase());
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));

    const filtered = closed.filter((r) => {
      const day = String(r.closedAt || '').slice(0, 10);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (storeFilter && r.bestemmingNaam !== storeFilter) return false;
      if (onlyLate && !r.wasTeLaat) return false;
      return true;
    });

    const stats = computeDragersHistoryStats(filtered);

    return res.status(200).json({
      success: true,
      from, to, store: storeFilter || null, onlyLate,
      totalInHistory: closed.length,
      historyUpdatedAt: updatedAt,
      stats,
      rows: filtered.slice(0, limit),
      truncated: filtered.length > limit
    });
  } catch (error) {
    console.error('[admin/dragers-history]', error);
    return res.status(200).json({ success: false, message: error.message || 'Geschiedenis laden mislukte.' });
  }
}
