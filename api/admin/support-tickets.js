import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getSupportTickets } from '../../lib/support-tickets-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(
    req.headers['x-admin-token'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).trim();
  return token === adminToken;
}

/**
 * GET /api/admin/support-tickets
 *
 * Admin overzicht van support tickets over ALLE winkels.
 * Optionele query: store, status, priority, limit (default 500).
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
  const limit = Math.max(1, Math.min(2000, Number(req.query.limit) || 500));

  try {
    /* Geen store filter in store-call → alle tickets over alle winkels */
    const tickets = await getSupportTickets({ store, limit });
    return res.status(200).json({ success: true, count: tickets.length, tickets });
  } catch (error) {
    console.error('[admin/support-tickets]', error);
    return res.status(500).json({ success: false, message: error.message || 'Tickets konden niet worden opgehaald.' });
  }
}
