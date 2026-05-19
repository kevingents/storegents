/**
 * POST /api/admin/facilitair/process
 *
 * Admin werkt een facilitair-bestelling bij: status, leverdatum, notitie.
 * Stuurt automatisch een status-update mail naar de winkel (indien email
 * bekend via FACILITAIR_STORE_MAIL_<storeKey> env vars of via algemene
 * STORE_MAIL fallback).
 *
 * Body:
 *   {
 *     id: 'order-id',
 *     status: 'in_behandeling' | 'onderweg' | 'geleverd' | 'afgewezen',
 *     deliveryEta: '2026-05-22' (optioneel),
 *     adminNote: 'optioneel',
 *     actor: 'Naam admin' (optioneel)
 *   }
 */

import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { updateFacilitairOrder } from '../../../lib/facilitair-orders-store.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function statusLabel(status) {
  return {
    open: 'Open',
    in_behandeling: 'In behandeling',
    onderweg: 'Onderweg',
    geleverd: 'Geleverd',
    afgewezen: 'Afgewezen'
  }[status] || status;
}

async function sendStatusMailToStore(order) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'no-api-key' };
  /* Probeer per-store-mail via env var (FACILITAIR_STORE_MAIL_GENTS_TILBURG=...),
     anders algemene STORE_MAIL fallback. */
  const storeKey = String(order.store || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const to =
    process.env[`FACILITAIR_STORE_MAIL_${storeKey}`] ||
    process.env.FACILITAIR_STORE_MAIL_DEFAULT ||
    process.env.STORE_MAIL ||
    '';
  if (!to) return { sent: false, reason: 'no-store-email-configured' };
  const from = process.env.RESEND_FROM_EMAIL || 'GENTS Portaal <portal@gents.nl>';
  const subject = `Facilitair-bestelling ${order.store}: ${statusLabel(order.status)}`;
  const itemsHtml = order.items
    .map((item) => `<li>${item.name} — <strong>${item.quantity} ${item.unit}</strong></li>`)
    .join('');
  const eta = order.deliveryEta ? `<p><strong>Verwachte levering:</strong> ${new Date(order.deliveryEta).toLocaleDateString('nl-NL')}</p>` : '';
  const note = order.adminNote ? `<p style="padding:10px;background:#eff6ff;border-left:3px solid #3b82f6">${order.adminNote.replace(/\n/g, '<br>')}</p>` : '';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;max-width:600px;color:#0a1f33">
      <h2>Status-update: <em>${statusLabel(order.status)}</em></h2>
      <p>Je bestelling van ${new Date(order.createdAt).toLocaleDateString('nl-NL')} is bijgewerkt.</p>
      ${eta}
      ${note}
      <p><strong>Producten:</strong></p>
      <ul>${itemsHtml}</ul>
      <p style="margin-top:18px;font-size:12px;color:#64748b">Status zichtbaar in het portaal onder "Facilitair-bestellingen".</p>
    </div>
  `;
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html })
    });
    return { sent: response.ok };
  } catch (error) {
    return { sent: false, reason: error.message };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const order = await updateFacilitairOrder(body.id, {
      status: body.status,
      deliveryEta: body.deliveryEta,
      adminNote: body.adminNote,
      actor: body.actor,
      note: body.note
    });
    const mail = await sendStatusMailToStore(order);
    return res.status(200).json({ success: true, order, mail });
  } catch (error) {
    console.error('[admin/facilitair/process]', error);
    return res.status(400).json({ success: false, message: error.message || 'Update mislukt.' });
  }
}
