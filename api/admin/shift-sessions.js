/**
 * Admin-overzicht van alle actieve + recente shifts.
 *
 *   GET    /api/admin/shift-sessions             → alle actieve + last 100 history
 *   DELETE /api/admin/shift-sessions?ip=...&store=...&reason=admin-end
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { listAllShifts, endShift, reapExpiredShifts } from '../../lib/shift-session-store.js';

export const maxDuration = 15;

function clean(v) { return String(v == null ? '' : v).trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'DELETE', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'DELETE', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
      const data = await listAllShifts({ limit });
      return res.status(200).json({ success: true, ...data });
    }

    if (req.method === 'DELETE') {
      const ip = clean(req.query.ip);
      const store = clean(req.query.store);
      const reason = clean(req.query.reason) || 'admin-end';
      if (!ip || !store) return res.status(400).json({ success: false, message: 'ip + store verplicht.' });
      const ended = await endShift({ ip, store, reason });
      return res.status(200).json({ success: true, ended });
    }

    if (req.method === 'POST') {
      /* Reap expired (admin-triggerable cleanup) */
      const reaped = await reapExpiredShifts();
      return res.status(200).json({ success: true, reaped });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/shift-sessions]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
