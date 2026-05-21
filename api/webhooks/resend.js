import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { appendMailEvent } from '../../lib/mail-events-store.js';
import { markEmailBounced } from '../../lib/office-users-store.js';
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * POST /api/webhooks/resend
 *
 * Webhook endpoint voor Resend events.
 *
 * Setup in Resend dashboard:
 *   1. Webhooks → Add Endpoint
 *   2. Endpoint URL: https://storegents.vercel.app/api/webhooks/resend
 *   3. Select events to listen:
 *        - email.sent
 *        - email.delivered
 *        - email.bounced
 *        - email.complained
 *        - email.delivery_delayed (optioneel)
 *        - email.opened / email.clicked (optioneel — tracking)
 *   4. Kopieer Signing Secret (whsec_...) → Vercel env als RESEND_WEBHOOK_SECRET
 *
 * Resend gebruikt het Svix webhook-protocol:
 *   - Header `svix-id`: uniek event-id (idempotency)
 *   - Header `svix-timestamp`: unix-seconds toen Resend stuurde
 *   - Header `svix-signature`: `v1,<base64-hmac-sha256>` (kan meerdere zijn, spaties-gescheiden)
 *   - HMAC wordt berekend over: `${svixId}.${svixTimestamp}.${rawBody}` met secret-bytes
 *
 * Body schema bij bounce:
 *   {
 *     "type": "email.bounced",
 *     "created_at": "...",
 *     "data": {
 *       "email_id": "re_xyz",
 *       "from": "...", "to": ["..."], "subject": "...",
 *       "bounce": { "type": "hard"|"soft", "message": "..." },
 *       "tags": [{ "name": "category", "value": "voucher" }]
 *     }
 *   }
 *
 * Bij `email.bounced` met type='hard' markeren we het mailadres als bounced
 * in de office-users store zodat verdere mails niet naar dood adres gestuurd worden.
 */

/* Vercel: schakel automatische body-parser uit zodat we de RAW body kunnen
   ophalen voor HMAC-verificatie. Body wordt handmatig geparsed na verificatie. */
export const config = {
  api: { bodyParser: false }
};

const MAX_TIMESTAMP_SKEW_SEC = 5 * 60; /* 5 min tolerance */

async function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Verifieer svix-style signature.
 *
 * @param {string} secret      "whsec_<base64>" of pure base64
 * @param {string} svixId      svix-id header
 * @param {string} svixTimestamp  svix-timestamp header (unix sec)
 * @param {string} rawBody     UTF-8 raw body string
 * @param {string} headerSig   svix-signature header (kan meerdere zijn)
 * @returns {boolean}
 */
function verifySvixSignature(secret, svixId, svixTimestamp, rawBody, headerSig) {
  if (!secret || !svixId || !svixTimestamp || !headerSig) return false;

  /* Timestamp anti-replay check */
  const ts = Number(svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) > MAX_TIMESTAMP_SKEW_SEC) {
    console.warn('[webhooks/resend] timestamp te oud:', { ts, nowSec, diff: nowSec - ts });
    return false;
  }

  /* Resend secret komt als "whsec_<base64-secret>" — strip prefix en decode */
  const cleanSecret = String(secret).replace(/^whsec_/, '');
  let secretBytes;
  try {
    secretBytes = Buffer.from(cleanSecret, 'base64');
  } catch {
    return false;
  }
  if (!secretBytes.length) return false;

  const toSign = `${svixId}.${svixTimestamp}.${rawBody}`;
  const expectedBase64 = createHmac('sha256', secretBytes).update(toSign).digest('base64');

  /* Header kan meerdere signatures bevatten: "v1,sig1 v1,sig2" — accepteer als één matcht */
  const provided = String(headerSig).split(/\s+/).filter(Boolean);
  for (const sigPart of provided) {
    const sigB64 = sigPart.replace(/^v1,/, '');
    try {
      const sigBuf = Buffer.from(sigB64, 'base64');
      const expBuf = Buffer.from(expectedBase64, 'base64');
      if (sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)) return true;
    } catch {
      /* continue */
    }
  }
  return false;
}

function tagsToMap(tags) {
  if (!Array.isArray(tags)) return undefined;
  const m = {};
  for (const t of tags) {
    if (t && t.name) m[t.name] = t.value || '';
  }
  return Object.keys(m).length ? m : undefined;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  let rawBody = '';
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    console.error('[webhooks/resend] raw body read fail:', error);
    return res.status(400).json({ received: false, error: 'Body niet leesbaar.' });
  }

  /* Signature-verificatie — alleen als secret geconfigureerd is */
  const secret = String(process.env.RESEND_WEBHOOK_SECRET || '').trim();
  const svixId = String(req.headers['svix-id'] || '').trim();
  const svixTimestamp = String(req.headers['svix-timestamp'] || '').trim();
  const svixSig = String(req.headers['svix-signature'] || '').trim();

  if (secret) {
    const valid = verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSig);
    if (!valid) {
      console.warn('[webhooks/resend] signature ongeldig — afgewezen');
      return res.status(401).json({ received: false, error: 'Ongeldige signature.' });
    }
  } else {
    console.warn('[webhooks/resend] geen RESEND_WEBHOOK_SECRET ingesteld — accepteer zonder check.');
  }

  /* Body parsen */
  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch (error) {
    return res.status(400).json({ received: false, error: 'Body is geen geldige JSON.' });
  }

  const type = String(body.type || '').toLowerCase();
  const data = body.data || {};
  const occurredAt = body.created_at || data.created_at || new Date().toISOString();

  /* Resend stuurt to als array — flat naar primary recipient */
  const toArray = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : []);
  const to = toArray[0] || '';

  const event = {
    id: svixId || body.id || `${type}-${data.email_id || ''}-${occurredAt}`,
    type,
    resendMessageId: data.email_id || data.id || '',
    to,
    from: data.from || '',
    subject: data.subject || '',
    occurredAt,
    bounceType: data.bounce?.type || data.bounceType || undefined,
    reason: data.bounce?.message || data.reason || undefined,
    tags: tagsToMap(data.tags)
  };

  try {
    const result = await appendMailEvent(event);

    /* Bij hard bounce: markeer e-mailadres als bounced in office-users zodat
       admin-UI dit kan tonen en herhaalde verzending vermeden kan worden. */
    if (type === 'email.bounced' && event.bounceType === 'hard' && to) {
      try {
        await markEmailBounced(to, {
          reason: event.reason || '',
          messageId: event.resendMessageId,
          at: occurredAt
        });
      } catch (markError) {
        console.warn('[webhooks/resend] markEmailBounced fail:', markError.message);
      }
    }

    return res.status(200).json({
      received: true,
      duplicate: result?.duplicate || false,
      verified: Boolean(secret),
      type
    });
  } catch (error) {
    console.error('[webhooks/resend] error:', error);
    /* Toch 200 returnen zodat Resend niet retries spamt; loggen voor diagnose */
    return res.status(200).json({ received: false, error: error.message });
  }
}
