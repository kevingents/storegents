import { handleCors, setCorsHeaders } from '../lib/cors.js';
import { getAllFeatureFlags } from '../lib/feature-flags-store.js';

/**
 * Publiek (geen admin-token vereist) endpoint dat alleen de enabled/disabled
 * status retourneert van bekende feature flags. Geen metadata (updatedAt,
 * updatedBy) — die staat in /api/admin/feature-flags.
 *
 * Wordt gebruikt door de frontend (admin sidebar) om te bepalen welke
 * nav-groepen wel/niet getoond moeten worden.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const flags = await getAllFeatureFlags();
    const result = {};
    for (const [key, val] of Object.entries(flags || {})) {
      result[key] = Boolean(val?.enabled);
    }
    return res.status(200).json({ success: true, flags: result });
  } catch (error) {
    console.error('[feature-flags] error:', error);
    /* Stil falen — bij fout returnen we 'alle features uit' zodat geen UI ten onrechte zichtbaar wordt */
    return res.status(200).json({ success: true, flags: {}, degraded: true });
  }
}
