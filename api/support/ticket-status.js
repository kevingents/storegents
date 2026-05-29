import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { updateSupportTicketStatus } from '../../lib/support-tickets-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
  const token = String(
    req.headers['x-admin-token'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).trim();
  return token === adminToken;
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

const ALLOWED_STATUSES = new Set(['open', 'progress', 'closed', 'rejected']);

/**
 * POST /api/support/ticket-status
 * Body: { ticketId, status, note? }
 *
 * Admin-only: status van een ticket wijzigen (open/progress/closed/rejected).
 * Note wordt toegevoegd aan statusHistory.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'Niet bevoegd.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Alleen POST is toegestaan.' });
  }

  const body = parseBody(req);
  const ticketId = String(body.ticketId || body.id || '').trim();
  const statusRaw = String(body.status || '').toLowerCase().trim();
  const note = String(body.note || '').trim();

  if (!ticketId) return res.status(400).json({ success: false, error: 'ticketId is verplicht.' });
  if (!ALLOWED_STATUSES.has(statusRaw)) {
    return res.status(400).json({
      success: false,
      error: `status moet één van: ${[...ALLOWED_STATUSES].join(', ')}`
    });
  }

  try {
    const ticket = await updateSupportTicketStatus(ticketId, statusRaw, note);
    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket niet gevonden.' });
    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error('[support/ticket-status]', error);
    return res.status(500).json({ success: false, error: error.message || 'Status update mislukt.' });
  }
}
