/**
 * POST /api/me/shift-end
 *
 * Sluit een actieve shift af. Body: { store?: string, reason?: string }
 *   - store: optioneel, default = IP-matched store
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { resolveAccess } from '../../lib/access-check.js';
import { endShift } from '../../lib/shift-session-store.js';

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  try {
    const body = parseBody(req);
    const access = await resolveAccess(req);
    if (!access.ip) return res.status(400).json({ success: false, message: 'Geen IP.' });

    const store = String(body.store || access.matchedStore || '').trim();
    if (!store) return res.status(400).json({ success: false, message: 'Geen winkel.' });

    const reason = String(body.reason || 'manual').trim();
    const ended = await endShift({ ip: access.ip, store, reason });
    return res.status(200).json({ success: true, ended });
  } catch (e) {
    console.error('[me/shift-end]', e);
    return res.status(500).json({ success: false, message: e.message || 'Uitloggen mislukt.' });
  }
}
