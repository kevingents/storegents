/**
 * POST /api/reserveringen/update
 *
 * Wijzig reservering-status (opgehaald / opgeheven / verlopen) of patch
 * geldigTot / note / customer.
 *
 * Body: { id, status?, geldigTot?, note?, customer?, actor? }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { updateReservering } from '../../lib/reserveringen-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const id = String(body.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'Geef reservering-id mee.' });
    const next = await updateReservering(id, body, body.actor);
    return res.status(200).json({ success: true, reservering: next });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message });
  }
}
