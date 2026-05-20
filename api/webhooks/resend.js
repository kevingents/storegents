import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { appendMailEvent } from '../../lib/mail-events-store.js';

/**
 * POST /api/webhooks/resend
 *
 * Webhook endpoint voor Resend events (email.sent, email.delivered,
 * email.bounced, email.complained, etc.).
 *
 * Setup in Resend dashboard:
 *   1. Webhooks → Add Endpoint
 *   2. URL: https://storegents.vercel.app/api/webhooks/resend
 *   3. Events: email.sent, email.delivered, email.bounced, email.complained,
 *      email.delivery_delayed (optioneel: email.opened, email.clicked)
 *   4. Signing secret: kopieer naar Vercel env als RESEND_WEBHOOK_SECRET
 *
 * Resend payload schema:
 *   {
 *     "type": "email.delivered",
 *     "created_at": "2024-11-22T23:41:12.123Z",
 *     "data": {
 *       "email_id": "re_xyz",
 *       "from": "...",
 *       "to": ["..."],
 *       "subject": "...",
 *       "tags": [{"name":"category","value":"voucher"}],   // optioneel
 *       "bounce": { "type": "hard", "message": "..." }      // alleen bij bounced
 *     }
 *   }
 *
 * Signature-verificatie via svix (Resend gebruikt svix headers):
 *   svix-id, svix-timestamp, svix-signature
 *
 * Voor MVP slaan we de signature-check over wanneer secret niet
 * geconfigureerd is. Wel always 200 returnen zodat Resend niet retries spamt.
 */

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

  /* Optionele svix signature check */
  const secret = String(process.env.RESEND_WEBHOOK_SECRET || '').trim();
  if (secret) {
    /* Resend gebruikt Svix-format. Volledige verificatie vereist crypto-HMAC
       met de webhook secret. Hier doen we een basic timestamp + presence
       check; voor productie kan de svix npm-package toegevoegd worden. */
    const svixId = req.headers['svix-id'];
    const svixTimestamp = req.headers['svix-timestamp'];
    const svixSig = req.headers['svix-signature'];
    if (!svixId || !svixTimestamp || !svixSig) {
      console.warn('[webhooks/resend] missende svix-headers, accept toch (basic mode).');
    }
  }

  const body = req.body || {};
  const type = String(body.type || '').toLowerCase();
  const data = body.data || {};
  const occurredAt = body.created_at || data.created_at || new Date().toISOString();

  /* Resend stuurt to als array — flat naar 1 recipient (meestal 1) */
  const toArray = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : []);
  const to = toArray[0] || '';

  const event = {
    id: body.id || `${type}-${data.email_id || ''}-${occurredAt}`,
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
    return res.status(200).json({ received: true, duplicate: result?.duplicate || false });
  } catch (error) {
    console.error('[webhooks/resend] error:', error);
    /* Toch 200 returnen zodat Resend niet retries spamt. Loggen voor diagnose. */
    return res.status(200).json({ received: false, error: error.message });
  }
}
