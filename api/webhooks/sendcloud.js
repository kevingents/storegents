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
 * Sendcloud stuurt o.a. action=parcel_status_changed met een parcel-object
 * dat order_number, tracking_number, carrier en status bevat.
 *
 * Matching: het parcel.order_number is het SRS-ordernummer (BOL-NNNN voor
 * bol-orders). We zoeken de bijbehorende bol-order en zetten de tracking door.
 * Alleen parcels waarvan order_number met "BOL-" begint worden verwerkt.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  findBolOrderBySrsOrderId,
  isBolOrderShipped,
  markBolOrderShippedManual
} from '../../lib/bol-shipment-push.js';
import { isBolOrderCancelled } from '../../lib/bol-cancellations-store.js';
import { sendcloudToBolTransporter, normPostal, houseNumberOnly } from '../../lib/sendcloud-parcels.js';

export const config = { api: { bodyParser: false } };

const clean = (v) => String(v == null ? '' : v).trim();

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* Sendcloud ondertekent de payload met HMAC-SHA256 (hex) in de header
   Sendcloud-Signature, met het integratie-webhook-secret als key. */
function verifySendcloudSignature(secret, rawBody, headerSig) {
  if (!secret || !headerSig) return false;
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  try {
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(clean(headerSig), 'hex');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ received: false, error: 'Alleen POST.' });

  let rawBody = '';
  try { rawBody = await readRawBody(req); }
  catch { return res.status(400).json({ received: false, error: 'Body niet leesbaar.' }); }

  /* Signature-verificatie alleen als secret geconfigureerd is. */
  const secret = clean(process.env.SENDCLOUD_WEBHOOK_SECRET);
  const sig = clean(req.headers['sendcloud-signature'] || req.headers['x-sendcloud-signature']);
  if (secret && !verifySendcloudSignature(secret, rawBody, sig)) {
    console.warn('[webhooks/sendcloud] signature ongeldig — afgewezen');
    return res.status(401).json({ received: false, error: 'Ongeldige signature.' });
  }

  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; }
  catch { return res.status(400).json({ received: false, error: 'Body is geen geldige JSON.' }); }

  const action = clean(body.action);
  const parcel = body.parcel || body.data?.parcel || {};
  const orderNumber = clean(parcel.order_number);
  const trackingNumber = clean(parcel.tracking_number);

  /* Alleen bol-orders (order_number = BOL-NNNN) zijn relevant. */
  if (!orderNumber || !orderNumber.toUpperCase().startsWith('BOL-')) {
    /* Andere parcels (webshop-orders) negeren we — niet ons probleem. */
    return res.status(200).json({ received: true, ignored: true, reason: 'order_number niet BOL-*', orderNumber });
  }
  if (!trackingNumber) {
    /* Status-update zonder tracking (bv. label aangemaakt maar nog geen
       tracking): accepteren maar niets doen — komt later opnieuw mét tracking. */
    return res.status(200).json({ received: true, pending: true, reason: 'nog geen tracking_number', orderNumber, action });
  }

  try {
    /* Zoek de bol-order die hoort bij dit SRS-ordernummer. */
    const found = await findBolOrderBySrsOrderId(orderNumber);
    if (!found) {
      return res.status(200).json({ received: true, unmatched: true, reason: `Geen bol-order met srsOrderId ${orderNumber}`, orderNumber });
    }
    const bolOrderId = found.bolOrderId;

    /* Idempotency + cancel-guard. */
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
    /* 200 zodat Sendcloud niet eindeloos retry't; loggen voor diagnose. */
    return res.status(200).json({ received: false, error: e.message, orderNumber });
  }
}
