/**
 * /api/facilitair/orders
 *   GET  ?store=...        — bestellingen voor één winkel (of alle voor admin)
 *   POST                   — nieuwe bestelling submitten
 *
 * POST body:
 *   {
 *     store: 'GENTS Tilburg',
 *     employeeName: 'Naam',
 *     items: [{ id: 'klantformulier', quantity: 100, advisedQuantity: 92 }, ...],
 *     note: 'optioneel',
 *     snapshotVolumes: { transactions: 280, weborders: 45 }
 *   }
 *
 * Bij succes: ticket aangemaakt in Blob + mail naar admin + bevestiging naar
 * medewerker (indien mail-adres bekend).
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  createFacilitairOrder,
  getFacilitairOrders
} from '../../lib/facilitair-orders-store.js';

function isAuthorized(req) {
  /* Voor GET met ?adminAll=1 → admin-token vereist; anders ?store=... volstaat. */
  if (req.method === 'GET' && String(req.query.adminAll || '') !== '1') return true;
  const expected = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

async function sendAdminMail(order, req) {
  const apiKey = process.env.RESEND_API_KEY;
  /* Fallback-keten: specifieke admin-mail, daarna algemene admin/store-default,
     anders het RESEND_FROM_EMAIL. Eén env (FACILITAIR_STORE_MAIL_DEFAULT)
     dekt nu zowel admin-notificatie als winkel-status-updates. */
  const toEnv = process.env.FACILITAIR_ADMIN_MAIL
    || process.env.ADMIN_MAIL
    || process.env.FACILITAIR_STORE_MAIL_DEFAULT
    || process.env.STORE_MAIL
    || process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !toEnv) {
    return { sent: false, reason: 'mail-niet-geconfigureerd' };
  }
  const from = process.env.RESEND_FROM_EMAIL || 'GENTS Portaal <portal@gents.nl>';
  const subject = `Facilitair: nieuwe bestelling van ${order.store} (${order.items.length} producten)`;
  const itemsHtml = order.items
    .map((item) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">${item.name}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right">${item.quantity} ${item.unit}</td>
      <td style="padding:6px 10px;border-bottom:1px solid #eee;text-align:right;color:#94a3b8;font-size:12px">advies: ${item.advisedQuantity}</td></tr>`)
    .join('');
  const volumes = order.snapshotVolumes || {};
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;margin:0 auto;color:#0a1f33">
      <h2 style="margin:0 0 8px">Facilitair-bestelling</h2>
      <p style="color:#475569;margin:0 0 18px">${order.store} — ingediend door ${order.employeeName}</p>
      <p style="font-size:12px;color:#64748b">Volume laatste 30d: ${volumes.transactions || 0} transacties, ${volumes.weborders || 0} weborders</p>
      <table style="width:100%;border-collapse:collapse;margin-top:14px;font-size:13px">
        <thead><tr style="background:#f1f5f9"><th style="padding:8px 10px;text-align:left">Product</th><th style="padding:8px 10px;text-align:right">Besteld</th><th style="padding:8px 10px;text-align:right">Advies</th></tr></thead>
        <tbody>${itemsHtml}</tbody>
      </table>
      ${order.note ? `<p style="margin-top:18px;padding:12px;background:#fef3c7;border-left:3px solid #f59e0b;border-radius:4px"><strong>Toelichting:</strong><br>${order.note.replace(/\n/g, '<br>')}</p>` : ''}
      <p style="margin-top:20px;font-size:12px;color:#64748b">Verwerk via het admin-portal → Facilitair-bestellingen.</p>
    </div>
  `;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [toEnv], subject, html })
    });
    return { sent: response.ok };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'GET') {
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
    }
    try {
      const adminAll = String(req.query.adminAll || '') === '1';
      const store = String(req.query.store || '').trim();
      const status = String(req.query.status || '').trim();
      const orders = await getFacilitairOrders({ store: adminAll ? '' : store, status });
      return res.status(200).json({ success: true, count: orders.length, orders });
    } catch (error) {
      console.error('[facilitair/orders GET]', error);
      return res.status(500).json({ success: false, message: error.message || 'Kon bestellingen niet ophalen.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const order = await createFacilitairOrder(body);
      const mail = await sendAdminMail(order, req);
      return res.status(201).json({ success: true, order, mail });
    } catch (error) {
      console.error('[facilitair/orders POST]', error);
      return res.status(400).json({ success: false, message: error.message || 'Bestelling kon niet worden aangemaakt.' });
    }
  }

  return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
}
