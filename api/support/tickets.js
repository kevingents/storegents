import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getSupportTickets, stripInternalNotes } from '../../lib/support-tickets-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  const store = String(req.query.store || '').trim();
  const employeeName = String(req.query.employeeName || req.query.employee || '').trim();
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));

  try {
    const tickets = await getSupportTickets({ store, employeeName, limit });
    /* Veiligheidsfilter: winkel-facing API mag NOOIT interne admin-notities
       teruggeven. Strip ze hier expliciet ipv te vertrouwen op de store. */
    const safe = tickets.map(stripInternalNotes);
    return res.status(200).json({ success: true, count: safe.length, tickets: safe });
  } catch (error) {
    console.error('[support/tickets]', error);
    return res.status(500).json({ success: false, message: error.message || 'Tickets konden niet worden opgehaald.' });
  }
}
