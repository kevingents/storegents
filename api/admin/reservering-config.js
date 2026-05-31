/**
 * GET  /api/admin/reservering-config   → { config, defaults }
 * POST /api/admin/reservering-config   → sla aging-drempel op  (body: { agingDagen })
 *
 * Instelbare drempel "te lang in reservering" (default 7 dagen). Drijft de
 * aging-markering op de read-only Reserveringen-weergave.
 *
 * Auth: admin-token vereist.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getReserveringConfig, saveReserveringConfig, DEFAULT_RESERVERING_CONFIG } from '../../lib/reservering-config-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const config = await getReserveringConfig();
      return res.status(200).json({ success: true, config, defaults: DEFAULT_RESERVERING_CONFIG });
    }
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      if (body.agingDagen === undefined) {
        return res.status(400).json({ success: false, message: 'agingDagen ontbreekt.' });
      }
      const saved = await saveReserveringConfig({ agingDagen: body.agingDagen });
      return res.status(200).json({ success: true, config: saved });
    }
    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  } catch (error) {
    console.error('[admin/reservering-config]', error);
    return res.status(500).json({ success: false, message: error.message || 'Reservering-config kon niet worden verwerkt.' });
  }
}
