import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  getAllPickups,
  addPickup,
  removePickup,
  setPickupStatus
} from '../../lib/transport-pickups-store.js';

/**
 * /api/admin/transport-pickups — ophaallijst voor uitwisseling-transport.
 *
 * GET                                   → { success, pickups }
 * POST { action: 'add', pickup: {...} } → voeg uitwisseling toe (idempotent)
 * POST { action: 'remove', key }        → verwijder van de lijst
 * POST { action: 'status', key, status }→ zet status ('open'|'picked')
 */

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const pickups = await getAllPickups();
      return res.status(200).json({ success: true, pickups });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const action = String(body.action || 'add').trim().toLowerCase();

      switch (action) {
        case 'add': {
          const pickup = await addPickup(body.pickup || body);
          return res.status(200).json({ success: true, pickup });
        }
        case 'remove': {
          const ok = await removePickup(body.key);
          return res.status(200).json({ success: ok, message: ok ? 'Verwijderd van ophaallijst.' : 'Niet gevonden.' });
        }
        case 'status': {
          const ok = await setPickupStatus(body.key, body.status);
          return res.status(200).json({ success: ok });
        }
        default:
          return res.status(400).json({ success: false, message: `Onbekende action: ${action}` });
      }
    }

    return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
  } catch (error) {
    console.error('[admin/transport-pickups]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onbekende fout.' });
  }
}
