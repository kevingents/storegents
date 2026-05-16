import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { addSupportTicketReply } from '../../lib/support-tickets-store.js';

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

/**
 * POST /api/support/ticket-reply
 * Body: { ticketId, from?, author, text, attachmentUrl?, attachmentName? }
 *
 * Voegt een antwoord toe aan een bestaand ticket. Wordt door zowel
 * medewerker (vervolgvraag) als admin (antwoord) gebruikt. Geen
 * admin-auth nodig — store-scoped tickets zijn voldoende beveiligd.
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Alleen POST is toegestaan.' });
  }

  const body = parseBody(req);
  const ticketId = String(body.ticketId || body.id || '').trim();
  const text = String(body.text || body.message || '').trim();
  const author = String(body.author || body.employeeName || '').trim();
  const fromRaw = String(body.from || 'employee').toLowerCase();
  const from = ['admin', 'employee'].includes(fromRaw) ? fromRaw : 'employee';

  if (!ticketId) return res.status(400).json({ success: false, error: 'ticketId is verplicht.' });
  if (!text) return res.status(400).json({ success: false, error: 'Bericht ontbreekt.' });

  try {
    const ticket = await addSupportTicketReply(ticketId, {
      from,
      author,
      text,
      attachmentUrl: body.attachmentUrl || '',
      attachmentName: body.attachmentName || ''
    });

    if (!ticket) return res.status(404).json({ success: false, error: 'Ticket niet gevonden.' });

    return res.status(200).json({ success: true, ticket });
  } catch (error) {
    console.error('[support/ticket-reply]', error);
    return res.status(500).json({ success: false, error: error.message || 'Reply kon niet worden toegevoegd.' });
  }
}
