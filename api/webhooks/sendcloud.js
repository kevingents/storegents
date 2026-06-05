/**
 * POST /api/webhooks/sendcloud
 *
 * Real-time webhook: zodra Sendcloud een parcel-status update stuurt (label
 * geprint / verzonden), zetten wij de tracking direct door naar bol — geen
 * wachten op de :40 cron.
 *
 * Setup in Sendcloud (Instellingen → Integraties → jouw integratie):
 *   1. Vink "Webhook feedback ingeschakeld" aan
 *   2. Webhook url: https://portal.gents.nl/api/webhooks/sendcloud
 *   3. (optioneel) zet het webhook-secret als env SENDCLOUD_WEBHOOK_SECRET
 *      voor HMAC-verificatie van de Sendcloud-Signature header.
 *
 * Sendcloud stuurt o.a. action=parcel_status_changed met een parcel-object.
 * Bij het opslaan/testen van de webhook stuurt Sendcloud een test-ping
 * (action=integration_*); die accepteren we met 200 zonder verder iets te doen.
 *
 * Robuustheid: ALLE imports zijn lazy (binnen de handler) en alles zit in een
 * top-level try/catch zodat een module-load- of runtime-fout nooit een 500
 * naar Sendcloud teruggeeft (dat blokkeert het opslaan van de webhook).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const config = { api: { bodyParser: false } };

const clean = (v) => String(v == null ? '' : v).trim();

async function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

/* Sendcloud ondertekent de payload met HMAC-SHA256 (hex) in de header
   Sendcloud-Signature, met het integratie-webhook-secret als key. */
function verifySendcloudSignature(secret, rawBody, headerSig) {
  if (!secret || !headerSig) return false;
  try {
    const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(clean(headerSig), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  /* CORS minimaal inline (geen import-afhankelijkheid die kan falen). */
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Sendcloud-Signature, X-Sendcloud-Signature');
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(204).end();
  /* Sendcloud test soms met GET → 200 zodat de URL als bereikbaar geldt. */
  if (req.method === 'GET') return res.status(200).json({ ok: true, endpoint: 'sendcloud-webhook' });
  if (req.method !== 'POST') return res.status(200).json({ received: true, ignored: true, reason: 'method' });

  try {
    const rawBody = await readRawBody(req);

    /* Signature-verificatie alleen als secret geconfigureerd is. */
    const secret = clean(process.env.SENDCLOUD_WEBHOOK_SECRET);
    const sig = clean(req.headers['sendcloud-signature'] || req.headers['x-sendcloud-signature']);
    if (secret && sig && !verifySendcloudSignature(secret, rawBody, sig)) {
      console.warn('[webhooks/sendcloud] signature ongeldig — afgewezen');
      return res.status(401).json({ received: false, error: 'Ongeldige signature.' });
    }

    let body = {};
    try { body = rawBody ? JSON.parse(rawBody) : {}; } catch { body = {}; }

    const action = clean(body.action);
    const parcel = body.parcel || body.data?.parcel || {};
    const orderNumber = clean(parcel.order_number);
    const trackingNumber = clean(parcel.tracking_number);

    /* Test-ping bij webhook-opslaan (geen echt parcel) → 200, niets doen. */
    if (!parcel || (!orderNumber && !trackingNumber)) {
      return res.status(200).json({ received: true, test: true, action: action || null });
    }

    /* Alleen bol-orders (order_number = BOL-NNNN) zijn relevant. */
    if (!orderNumber || !orderNumber.toUpperCase().startsWith('BOL-')) {
      return res.status(200).json({ received: true, ignored: true, reason: 'order_number niet BOL-*', orderNumber });
    }
    if (!trackingNumber) {
      return res.status(200).json({ received: true, pending: true, reason: 'nog geen tracking_number', orderNumber, action });
    }

    /* Lazy imports — een module-load-fout mag nooit een 500 geven (dat
       blokkeert het opslaan van de webhook in Sendcloud). */
    const { findBolOrderBySrsOrderId, isBolOrderShipped, markBolOrderShippedManual } =
      await import('../../lib/bol-shipment-push.js');
    const { isBolOrderCancelled } = await import('../../lib/bol-cancellations-store.js');
    const { sendcloudToBolTransporter } = await import('../../lib/sendcloud-parcels.js');

    const found = await findBolOrderBySrsOrderId(orderNumber);
    if (!found) {
      return res.status(200).json({ received: true, unmatched: true, reason: `Geen bol-order met srsOrderId ${orderNumber}`, orderNumber });
    }
    const bolOrderId = found.bolOrderId;

    if (await isBolOrderShipped(bolOrderId)) {
      return res.status(200).json({ received: true, alreadyShipped: true, bolOrderId, orderNumber });
    }
    if (await isBolOrderCancelled(bolOrderId)) {
      return res.status(200).json({ received: true, cancelled: true, bolOrderId, orderNumber });
    }

    const transporterCode = sendcloudToBolTransporter(parcel);
    const shippingMethod = clean(parcel.shipment?.name || parcel.carrier?.code);

    const result = await markBolOrderShippedManual(bolOrderId, {
      trackAndTrace: trackingNumber,
      transporterCode,
      shipmentReference: orderNumber,
      shippingMethod
    });

    return res.status(200).json({
      received: true,
      shipped: true,
      bolOrderId,
      orderNumber,
      trackingNumber,
      transporterCode,
      bolProcessId: result?.bolProcessId || null,
      via: 'sendcloud-webhook'
    });
  } catch (e) {
    console.error('[webhooks/sendcloud]', e);
    /* ALTIJD 200 zodat Sendcloud de webhook accepteert + niet retry-spamt. */
    return res.status(200).json({ received: false, error: clean(e?.message).slice(0, 300) });
  }
}
