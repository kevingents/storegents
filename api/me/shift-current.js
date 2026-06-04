/**
 * GET /api/me/shift-current
 *
 * "Wie is er nu actief op dit IP?" — gebruikt door portal-UI om te weten of een
 * shift-login al heeft plaatsgevonden vandaag. Returnt actieve shifts per
 * store-context.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { resolveAccess } from '../../lib/access-check.js';
import { getActiveShift, getActiveShiftsByIp, touchShift } from '../../lib/shift-session-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const access = await resolveAccess(req);
    if (!access.ip) {
      return res.status(200).json({ success: true, shift: null, access });
    }

    const reqStore = String(req.query.store || access.matchedStore || '').trim();

    if (reqStore) {
      const shift = await getActiveShift({ ip: access.ip, store: reqStore });
      if (shift) {
        /* Heartbeat: shift blijft levend zolang user actief is */
        touchShift({ ip: access.ip, store: reqStore }).catch(() => {});
      }
      return res.status(200).json({ success: true, shift, access });
    }

    /* Geen specifieke store gevraagd → toon alle actieve shifts voor dit IP */
    const shifts = await getActiveShiftsByIp(access.ip);
    return res.status(200).json({ success: true, shifts, access });
  } catch (e) {
    console.error('[me/shift-current]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
