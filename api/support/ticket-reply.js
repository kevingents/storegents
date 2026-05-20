import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { addSupportTicketReply } from '../../lib/support-tickets-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';
import { getEmailForStore } from '../../lib/store-emails-store.js';

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function getSupportEmail() {
  return String(process.env.SUPPORT_EMAIL || process.env.ADMIN_EMAIL || '').trim();
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Verstuurt notification-mail bij een reply. Best-effort: stuurt niets
 * terug naar de caller (alleen log + return success), zodat de API-call
 * altijd snel slaagt ongeacht mail-status.
 */
async function sendReplyNotification({ ticket, reply }) {
  const isFromAdmin = reply.from === 'admin';
  const isFromEmployee = reply.from === 'employee';

  /* Wie krijgt de mail? */
  let to = '';
  let subject = '';
  let intro = '';
  let portalLinkLabel = '';

  if (isFromAdmin) {
    /* Admin antwoordt -> mail naar winkel-email */
    to = await getEmailForStore(ticket.store);
    if (!to) {
      console.warn('[ticket-reply mail] geen winkel-email gevonden voor', ticket.store);
      return { sent: false, reason: `Geen email voor winkel "${ticket.store}"` };
    }
    subject = `Antwoord op je support-ticket: ${ticket.subject}`;
    intro = `Hoofdkantoor heeft gereageerd op het ticket dat je aanmaakte vanuit ${ticket.store}.`;
    portalLinkLabel = 'Open in winkelportaal';
  } else if (isFromEmployee) {
    /* Winkel antwoordt -> mail naar admin */
    to = getSupportEmail();
    if (!to) {
      console.warn('[ticket-reply mail] geen SUPPORT_EMAIL/ADMIN_EMAIL env-var');
      return { sent: false, reason: 'SUPPORT_EMAIL niet geconfigureerd' };
    }
    subject = `Nieuwe reactie van ${ticket.store}: ${ticket.subject}`;
    intro = `${reply.author || 'Een medewerker'} van ${ticket.store} heeft gereageerd op support-ticket.`;
    portalLinkLabel = 'Open in admin';
  } else {
    return { sent: false, reason: 'Onbekende reply-from' };
  }

  const PRIORITY_LABEL = { low: 'Laag', medium: 'Medium', high: 'Hoog', urgent: 'Urgent' };
  const priorityLabel = PRIORITY_LABEL[ticket.priority] || ticket.priority || 'Medium';
  const allReplies = Array.isArray(ticket.replies) ? ticket.replies : [];
  const recentReplies = allReplies.slice(-3);

  const html = baseMailHtml({
    title: subject,
    intro,
    bodyHtml: `
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;margin-bottom:18px">
        <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;width:140px;font-weight:700;">Onderwerp</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${esc(ticket.subject)}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;font-weight:700;">Winkel</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${esc(ticket.store || '-')}</td></tr>
        <tr><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#3a4a5a;font-weight:700;">Prioriteit</td><td style="padding:8px 0;border-bottom:1px solid #eef2f7;font-size:14px;color:#0a1f33;">${esc(priorityLabel)}</td></tr>
        <tr><td style="padding:8px 0;font-size:14px;color:#3a4a5a;font-weight:700;">Status</td><td style="padding:8px 0;font-size:14px;color:#0a1f33;">${esc(ticket.status || 'open')}</td></tr>
      </table>

      <div style="padding:14px 16px;background:${isFromAdmin ? '#f0fdf4' : '#eff6ff'};border-left:4px solid ${isFromAdmin ? '#10b981' : '#0ea5e9'};border-radius:8px;margin-bottom:14px">
        <strong style="display:block;font-size:13px;color:${isFromAdmin ? '#059669' : '#0284c7'};margin-bottom:4px">${esc(reply.author || (isFromAdmin ? 'Hoofdkantoor' : 'Medewerker'))} schreef:</strong>
        <div style="font-size:14px;line-height:1.55;color:#0a1f33;white-space:pre-line">${esc(reply.text)}</div>
      </div>

      ${recentReplies.length > 1 ? `
        <details style="margin-bottom:14px">
          <summary style="cursor:pointer;font-size:12px;color:#3a4a5a;font-weight:700;padding:6px 0">Voorgaande berichten (${allReplies.length - 1})</summary>
          ${allReplies.slice(0, -1).slice(-5).map(r => `
            <div style="margin-top:8px;padding:10px 12px;background:${r.from === 'admin' ? '#f0fdf4' : '#eff6ff'};border-left:3px solid ${r.from === 'admin' ? '#10b981' : '#0ea5e9'};border-radius:6px">
              <strong style="font-size:11.5px;color:${r.from === 'admin' ? '#059669' : '#0284c7'}">${esc(r.author || (r.from === 'admin' ? 'Hoofdkantoor' : 'Medewerker'))}</strong>
              <span style="font-size:10.5px;color:#94a3b8;margin-left:6px">${esc(new Date(r.at).toLocaleString('nl-NL'))}</span>
              <div style="margin-top:4px;font-size:12.5px;color:#0a1f33;white-space:pre-line">${esc(String(r.text).slice(0, 400))}${r.text && r.text.length > 400 ? '…' : ''}</div>
            </div>
          `).join('')}
        </details>
      ` : ''}

      <div style="padding:12px;background:#f8fafc;border-radius:8px;font-size:12.5px;color:#3a4a5a;line-height:1.5">
        <strong>Reageer of bekijk de hele conversatie:</strong><br>
        ${isFromAdmin
          ? 'Log in op het winkelportaal en open <strong>Mijn tickets</strong> in het menu om te reageren.'
          : 'Log in op admin en open <strong>Support tickets</strong> in het menu (sectie Communicatie) om te reageren.'}
      </div>
    `,
    footer: 'Automatisch verstuurd vanuit het GENTS Winkelportaal — support helpdesk.'
  });

  try {
    await sendMail({
      to,
      subject,
      html,
      text: `${reply.author || (isFromAdmin ? 'Hoofdkantoor' : 'Medewerker')} schreef op ticket "${ticket.subject}":\n\n${reply.text}\n\n--\nLog in op het portaal voor de hele conversatie.`
    });
    return { sent: true, to };
  } catch (error) {
    console.error('[ticket-reply mail] verzenden mislukt:', error);
    return { sent: false, reason: error.message || 'mail-fout' };
  }
}

/**
 * POST /api/support/ticket-reply
 * Body: { ticketId, from?, author, text, attachmentUrl?, attachmentName? }
 *
 * Voegt een antwoord toe aan een bestaand ticket. Wordt door zowel
 * medewerker (vervolgvraag) als admin (antwoord) gebruikt. Geen
 * admin-auth nodig — store-scoped tickets zijn voldoende beveiligd.
 *
 * Bij succes: stuurt notificatie-mail naar de andere partij:
 *   - from=admin    -> mail naar winkel (via store-emails)
 *   - from=employee -> mail naar SUPPORT_EMAIL/ADMIN_EMAIL
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
  const skipMail = body.skipMail === true || body.skipMail === 'true';

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

    /* Mail-notificatie best-effort versturen */
    let mailStatus = { sent: false, reason: 'overgeslagen' };
    if (!skipMail) {
      const reply = ticket.replies[ticket.replies.length - 1];
      mailStatus = await sendReplyNotification({ ticket, reply });
    }

    return res.status(200).json({ success: true, ticket, mailStatus });
  } catch (error) {
    console.error('[support/ticket-reply]', error);
    return res.status(500).json({ success: false, error: error.message || 'Reply kon niet worden toegevoegd.' });
  }
}
