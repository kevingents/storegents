import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getPrizes, computeTotalPot, countPredictions } from '../../lib/wk-poule-store.js';

/**
 * /api/wk-poule/stats
 *
 * Publieke stats voor de WK Poule banner op het dashboard.
 * Levert: { totalPot, currency, deelnemers, deadline }
 *
 * Caching: 60s edge-cache — banner-data hoeft niet realtime te zijn.
 */

/* Vaste WK 2026 deadline — eerste wedstrijd opening WK Mexico/USA/Canada.
   Pas aan zodra FIFA exacte datum publiceert. */
const WK_2026_DEADLINE = '2026-06-11T16:00:00Z';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const [prizes, deelnemers] = await Promise.all([
      getPrizes(),
      countPredictions()
    ]);

    return res.status(200).json({
      success: true,
      totalPot: computeTotalPot(prizes),
      currency: 'EUR',
      deelnemers,
      deadline: WK_2026_DEADLINE
    });
  } catch (error) {
    console.error('[wk-poule/stats]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Stats kunnen niet worden geladen.',
      /* Defensive fallback zodat de banner niet kapotgaat */
      totalPot: 0,
      currency: 'EUR',
      deelnemers: 0,
      deadline: WK_2026_DEADLINE
    });
  }
}
