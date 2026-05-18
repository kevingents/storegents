/**
 * POST /api/pickup-notify-customer
 *
 * Body: { orderId, orderName, customerEmail, customerName, store, items }
 *
 * Stuurt een "je order ligt klaar" e-mail naar de klant van een pickup-order
 * en zet de Shopify order tag 'pickup_notified' zodat de winkel-portal en
 * cron-job hem als "customer informed" zien.
 *
 * Authenticatie: admin-token of winkel-context (geen public).
 */

import { sendMail, baseMailHtml, rowsTable } from '../lib/gents-mailer.js';
import { appendMailLog } from '../lib/gents-mail-log-store.js';
import { handleCors, setCorsHeaders } from '../lib/cors.js';

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE_URL = String(process.env.SHOPIFY_STORE_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.query?.adminToken ||
    req.body?.adminToken ||
    ''
  ).trim();
  return Boolean(adminToken && token && token === adminToken);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

async function tagShopifyOrderPickupNotified(orderId) {
  if (!SHOPIFY_ACCESS_TOKEN || !SHOPIFY_STORE_URL || !orderId) return false;
  try {
    const cleanId = String(orderId).replace('gid://shopify/Order/', '').replace(/^#/, '');
    /* Eerst huidige tags ophalen */
    const getRes = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/orders/${cleanId}.json?fields=id,tags`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });
    if (!getRes.ok) return false;
    const orderData = await getRes.json();
    const current = String(orderData.order?.tags || '');
    if (/pickup_notified/i.test(current)) return true; /* al getagd */
    const next = current ? `${current}, pickup_notified` : 'pickup_notified';
    const updateRes = await fetch(`https://${SHOPIFY_STORE_URL}/admin/api/${SHOPIFY_API_VERSION}/orders/${cleanId}.json`, {
      method: 'PUT',
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: { id: Number(cleanId), tags: next } })
    });
    return updateRes.ok;
  } catch (e) {
    console.error('[pickup-notify-customer] tag fail:', e.message);
    return false;
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  const body = parseBody(req);
  const orderId = String(body.orderId || '').trim();
  const orderName = String(body.orderName || body.orderNumber || '').trim();
  const customerEmail = String(body.customerEmail || '').trim().toLowerCase();
  const customerName = String(body.customerName || 'Klant').trim();
  const store = String(body.store || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];

  if (!customerEmail) return res.status(400).json({ success: false, message: 'customerEmail is verplicht.' });
  if (!orderName && !orderId) return res.status(400).json({ success: false, message: 'orderId of orderName is verplicht.' });

  try {
    const html = baseMailHtml({
      title: `Je bestelling ligt klaar in ${store || 'onze winkel'}`,
      intro: `Beste ${customerName.split(' ')[0] || customerName},<br><br>Je bestelling ${orderName} ligt klaar om af te halen in ${store ? `<strong>${store}</strong>` : 'onze winkel'}. Tot snel!`,
      bodyHtml: items.length ? rowsTable(items, [
        { label: 'Artikel', value: (i) => i.title || i.name || i.sku || '-' },
        { label: 'Aantal', value: (i) => i.quantity || i.qty || 1 }
      ]) : ''
    });

    const result = await sendMail({
      to: customerEmail,
      subject: `Je GENTS bestelling ligt klaar — ${orderName}`,
      html,
      text: `Beste ${customerName}, je bestelling ${orderName} ligt klaar in ${store}. Tot snel!`
    });

    /* Shopify order taggen + audit-log */
    const tagged = orderId ? await tagShopifyOrderPickupNotified(orderId) : false;
    await appendMailLog({
      type: 'pickup_customer_notify',
      store,
      key: orderId || orderName,
      order: orderName,
      recipient: customerEmail,
      status: 'sent',
      resendId: result.resendId || ''
    });

    return res.status(200).json({
      success: true,
      sent: true,
      orderName,
      customerEmail,
      shopifyTagged: tagged,
      resendId: result.resendId || ''
    });
  } catch (error) {
    console.error('[pickup-notify-customer]', error);
    await appendMailLog({
      type: 'pickup_customer_notify',
      store,
      key: orderId || orderName,
      order: orderName,
      recipient: customerEmail,
      status: 'error',
      message: error.message
    }).catch(() => {});
    return res.status(500).json({ success: false, message: error.message || 'E-mail kon niet worden verzonden.' });
  }
}
