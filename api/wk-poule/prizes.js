import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getPrizes, computeTotalPot } from '../../lib/wk-poule-store.js';

/**
 * /api/wk-poule/prizes
 *
 * Publieke read-only endpoint zodat de portal het overzicht van prijzen
 * (en de totale pot) kan tonen aan alle deelnemers.
 *
 * GET → { success, prizes, totalPot }
 *
 * Aanpassen kan alleen via /api/admin/wk-poule/prizes (admin-token vereist).
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  /* Korte cache: prijzen wijzigen zelden, dus 60s edge-cache spaart calls. */
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const prizes = await getPrizes();
    /* Voor publieke weergave: laat updatedBy weg (interne info). */
    const safePrizes = {
      items: prizes.items,
      manualPotOverride: prizes.manualPotOverride,
      notes: prizes.notes,
      updatedAt: prizes.updatedAt
    };
    return res.status(200).json({
      success: true,
      prizes: safePrizes,
      totalPot: computeTotalPot(prizes)
    });
  } catch (error) {
    console.error('[wk-poule/prizes]', error);
    return res.status(500).json({ success: false, message: error.message || 'Prijzen kunnen niet worden geladen.' });
  }
}
