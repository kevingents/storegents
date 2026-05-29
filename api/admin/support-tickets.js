import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getSupportTickets } from '../../lib/support-tickets-store.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.query.token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

/**
 * GET /api/admin/support-tickets
 *
 * Admin overzicht van support tickets over ALLE winkels.
 * Optionele query: store, status, priority, from/to, limit (default 500).
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  const store = String(req.query.store || '').trim();
  const status = String(req.query.status || '').trim().toLowerCase();
  const priority = String(req.query.priority || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));

  /* Periode-filter (optioneel) */
  const fromStr = String(req.query.from || req.query.dateFrom || '').trim();
  const toStr = String(req.query.to || req.query.dateTo || '').trim();
  const fromMs = fromStr ? new Date(fromStr + 'T00:00:00').getTime() : 0;
  const toMs = toStr ? new Date(toStr + 'T23:59:59').getTime() : 0;

  try {
    /* Geen store filter in store-call → alle tickets over alle winkels */
    const all = await getSupportTickets({ store, limit });
    const tickets = (all || []).filter((t) => {
      if (status && String(t.status || '').toLowerCase() !== status) return false;
      if (priority && String(t.priority || '').toLowerCase() !== priority) return false;
      if (fromMs || toMs) {
        const ts = new Date(t.createdAt || t.date || 0).getTime();
        if (Number.isNaN(ts)) return false;
        if (fromMs && ts < fromMs) return false;
        if (toMs && ts > toMs) return false;
      }
      return true;
    });
    return res.status(200).json({ success: true, count: tickets.length, tickets });
  } catch (error) {
    console.error('[admin/support-tickets]', error);
    return res.status(500).json({ success: false, message: error.message || 'Tickets konden niet worden opgehaald.' });
  }
}
