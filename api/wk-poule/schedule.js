import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getSchedule } from '../../lib/wk-poule-store.js';

/**
 * /api/wk-poule/schedule
 *
 * Publieke GET — levert het wedstrijdschema (incl. eventuele uitslagen).
 * Gebruikt door de WK Poule modal "Wedstrijden" tab.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const data = await getSchedule();
    return res.status(200).json({
      success: true,
      matches: data.matches || [],
      updatedAt: data.updatedAt || null
    });
  } catch (error) {
    console.error('[wk-poule/schedule]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Schedule kon niet worden geladen.',
      matches: []
    });
  }
}
