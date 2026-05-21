import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getConfig } from '../../lib/virtual-store-configs.js';

/**
 * GET /api/store/virtual-store-config?key=Students
 *
 * Returnt de zichtbaarheid-config voor een virtuele winkel — gebruikt door
 * de frontend om sidebar-items + modals te filteren wanneer een virtuele
 * winkel is geselecteerd.
 *
 * Geen admin-token nodig — winkel-medewerkers gebruiken dit ook.
 */

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'private, max-age=60');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const key = clean(req.query.key);
  if (!key) return res.status(400).json({ success: false, message: 'key ontbreekt' });

  try {
    const config = await getConfig(key);
    if (!config) {
      return res.status(200).json({
        success: true,
        key,
        config: null,
        message: 'Geen config gevonden — geen filtering toegepast.'
      });
    }
    return res.status(200).json({
      success: true,
      key,
      config: {
        key: config.key,
        label: config.label,
        defaultPage: config.defaultPage || null,
        allowedPages: config.allowedPages || [],
        allowedModals: config.allowedModals || [],
        active: config.active !== false
      }
    });
  } catch (error) {
    console.error('[store/virtual-store-config]', error);
    return res.status(500).json({ success: false, message: error.message || 'Config kon niet worden opgehaald.' });
  }
}
