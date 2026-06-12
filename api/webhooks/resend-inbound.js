import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { ingestDhlInvoice } from '../../lib/dhl-invoice-ingest.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * POST /api/webhooks/resend-inbound
 *
 * Inbound e-mail van Resend: stuur DHL-facturen naar het inbound-adres en deze
 * webhook verwerkt de PDF-bijlage automatisch (parse → opslaan), zodat de
 * transport-verdeling/-facturen vanzelf bijgewerkt worden.
 *
 * Setup in Resend dashboard:
 *   1. Domains → kies/voeg een SUBDOMEIN toe voor ontvangen (bv. inbound.gents.nl),
 *      óf gebruik het gratis default-adres dat Resend geeft (…@<account>.resend.app)
 *      als je geen DNS wilt aanpassen.
 *   2. Voeg het MX-record toe dat Resend toont (laagste priority) — alléén op het
 *      subdomein, zodat je gewone mail op gents.nl ongemoeid blijft.
 *   3. Webhooks → Add Endpoint:
 *        URL:    https://storegents.vercel.app/api/webhooks/resend-inbound
 *        Event:  email.received
 *      Kopieer de Signing Secret (whsec_…) → Vercel env RESEND_INBOUND_WEBHOOK_SECRET
 *      (valt terug op RESEND_WEBHOOK_SECRET als die niet apart gezet is).
 *
 * Resend levert bij inbound alléén metadata in de webhook (geen bijlage-bytes).
 * De PDF halen we op via de Attachments-API:
 *   GET https://api.resend.com/emails/receiving/{email_id}/attachments
 *   → data[].download_url (pre-signed) → fetch de bytes.
 *
 * Webhook-body (data): { email_id, from, to[], subject, attachments[] }
 *   attachment: { id, filename, content_type, content_disposition, content_id }
 */

export const config = {
  api: { bodyParser: false },
  maxDuration: 60,
};

const MAX_TIMESTAMP_SKEW_SEC = 5 * 60;

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Svix-style signature-verificatie (identiek aan api/webhooks/resend.js). */
function verifySvixSignature(secret, svixId, svixTimestamp, rawBody, headerSig) {
  if (!secret || !svixId || !svixTimestamp || !headerSig) return false;
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_TIMESTAMP_SKEW_SEC) return false;

  const cleanSecret = String(secret).replace(/^whsec_/, '');
  let secretBytes;
  try { secretBytes = Buffer.from(cleanSecret, 'base64'); } catch { return false; }
  if (!secretBytes.length) return false;

  const expectedBase64 = createHmac('sha256', secretBytes)
    .update(`${svixId}.${svixTimestamp}.${rawBody}`)
    .digest('base64');

  for (const sigPart of String(headerSig).split(/\s+/).filter(Boolean)) {
    const sigB64 = sigPart.replace(/^v1,/, '');
    try {
      const sigBuf = Buffer.from(sigB64, 'base64');
      const expBuf = Buffer.from(expectedBase64, 'base64');
      if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) return true;
    } catch { /* volgende */ }
  }
  return false;
}

function isPdf(att) {
  const ct = String(att?.content_type || '').toLowerCase();
  const fn = String(att?.filename || '').toLowerCase();
  return ct.includes('pdf') || fn.endsWith('.pdf');
}

/** Haal bijlage-metadata (incl. pre-signed download_url) op bij Resend. */
async function fetchAttachmentList(emailId, apiKey) {
  const r = await fetch(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}/attachments`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!r.ok) throw new Error(`Attachments-API ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  return Array.isArray(j?.data) ? j.data : [];
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ received: false, error: 'Alleen POST.' });

  let rawBody = '';
  try {
    rawBody = await readRawBody(req);
  } catch {
    return res.status(400).json({ received: false, error: 'Body niet leesbaar.' });
  }

  const secret = String(
    process.env.RESEND_INBOUND_WEBHOOK_SECRET || process.env.RESEND_WEBHOOK_SECRET || ''
  ).trim();
  if (secret) {
    const ok = verifySvixSignature(
      secret,
      String(req.headers['svix-id'] || '').trim(),
      String(req.headers['svix-timestamp'] || '').trim(),
      rawBody,
      String(req.headers['svix-signature'] || '').trim()
    );
    if (!ok) {
      console.warn('[resend-inbound] signature ongeldig — afgewezen');
      return res.status(401).json({ received: false, error: 'Ongeldige signature.' });
    }
  } else {
    console.warn('[resend-inbound] geen webhook-secret ingesteld — accepteer zonder check.');
  }

  let body = {};
  try { body = rawBody ? JSON.parse(rawBody) : {}; }
  catch { return res.status(400).json({ received: false, error: 'Body is geen geldige JSON.' }); }

  const type = String(body.type || '').toLowerCase();
  const data = body.data || {};
  if (type !== 'email.received') {
    /* Andere events negeren we netjes (200 zodat Resend niet blijft retryen). */
    return res.status(200).json({ received: true, ignored: type || 'onbekend' });
  }

  const emailId = String(data.email_id || data.id || '').trim();
  const from = String(data.from || '').trim();
  const metaAttachments = Array.isArray(data.attachments) ? data.attachments : [];
  const hasPdf = metaAttachments.some(isPdf);

  if (!emailId || !hasPdf) {
    return res.status(200).json({ received: true, processed: 0, reason: hasPdf ? 'geen email_id' : 'geen PDF-bijlage' });
  }

  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.error('[resend-inbound] RESEND_API_KEY ontbreekt — kan bijlage niet ophalen.');
    return res.status(200).json({ received: true, processed: 0, error: 'RESEND_API_KEY ontbreekt' });
  }

  const results = [];
  try {
    const list = await fetchAttachmentList(emailId, apiKey);
    for (const att of list.filter(isPdf)) {
      if (!att.download_url) { results.push({ filename: att.filename, error: 'geen download_url' }); continue; }
      try {
        const dl = await fetch(att.download_url);
        if (!dl.ok) { results.push({ filename: att.filename, error: `download ${dl.status}` }); continue; }
        const bytes = Buffer.from(await dl.arrayBuffer());
        const saved = await ingestDhlInvoice(bytes, { source: 'email', addedBy: from || 'e-mail' });
        results.push({ filename: att.filename, invoiceNumber: saved.invoiceNumber, shipments: saved.totalShipments });
      } catch (e) {
        /* NOT_DHL = bijlage is geen DHL-factuur → stil overslaan; rest loggen. */
        results.push({ filename: att.filename, error: e.code === 'NOT_DHL' ? 'geen DHL-factuur' : e.message });
      }
    }
  } catch (e) {
    console.error('[resend-inbound] attachment-ophalen mislukt:', e.message);
    return res.status(200).json({ received: true, processed: 0, error: e.message });
  }

  const processed = results.filter((r) => r.invoiceNumber).length;
  console.log(`[resend-inbound] van ${from}: ${processed} factuur(en) verwerkt`, results);
  return res.status(200).json({ received: true, processed, results });
}
