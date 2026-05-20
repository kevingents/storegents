import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  addSupportTicketInternalNote,
  removeSupportTicketInternalNote
} from '../../lib/support-tickets-store.js';

/**
 * POST   /api/support/ticket-internal-note  - voegt notitie toe
 * DELETE /api/support/ticket-internal-note  - verwijdert notitie
 *
 * ALLEEN admin. Internal notes zijn niet zichtbaar voor winkels (de
 * winkel-facing /api/support/tickets endpoint filtert ze actief weg via
 * stripInternalNotes()).
 *
 * POST body:   { ticketId, text, author? }
 * DELETE body: { ticketId, noteId }
 */
function isAdmin(req) {
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'DELETE', 'OPTIONS']);

  if (!isAdmin(req)) {
    return res.status(401).json({ success: false, error: 'Niet bevoegd. Alleen admin.' });
  }

  const body = parseBody(req);
  const ticketId = String(body.ticketId || body.id || '').trim();
  if (!ticketId) return res.status(400).json({ success: false, error: 'ticketId is verplicht.' });

  try {
    if (req.method === 'POST') {
      const text = String(body.text || body.note || '').trim();
      const author = String(body.author || 'Admin').trim();
      if (!text) return res.status(400).json({ success: false, error: 'Notitie-tekst ontbreekt.' });
      const ticket = await addSupportTicketInternalNote(ticketId, { author, text });
      if (!ticket) return res.status(404).json({ success: false, error: 'Ticket niet gevonden.' });
      return res.status(200).json({ success: true, ticket });
    }

    if (req.method === 'DELETE') {
      const noteId = String(body.noteId || '').trim();
      if (!noteId) return res.status(400).json({ success: false, error: 'noteId is verplicht.' });
      const ticket = await removeSupportTicketInternalNote(ticketId, noteId);
      if (!ticket) return res.status(404).json({ success: false, error: 'Ticket niet gevonden.' });
      return res.status(200).json({ success: true, ticket });
    }

    return res.status(405).json({ success: false, error: 'Alleen POST/DELETE is toegestaan.' });
  } catch (error) {
    console.error('[support/ticket-internal-note]', error);
    return res.status(500).json({ success: false, error: error.message || 'Internal note kon niet worden opgeslagen.' });
  }
}
