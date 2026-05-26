import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getRules } from '../../lib/wk-poule-store.js';

/**
 * /api/wk-poule/rules
 *
 * Publieke GET — poule-regels (puntenverdeling, deadlines). Read-only.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const data = await getRules();
    return res.status(200).json({
      success: true,
      ...data
    });
  } catch (error) {
    console.error('[wk-poule/rules]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Regels konden niet worden geladen.'
    });
  }
}
