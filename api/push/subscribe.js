/**
 * POST /api/push/subscribe
 * Body: { store, personnelId, subscription: { endpoint, keys: { p256dh, auth } } }
 */

import { upsertSubscription, removeSubscriptionByEndpoint } from '../../lib/push-subscriptions-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const body = parseBody(req);

  if (req.method === 'DELETE' || body?.action === 'unsubscribe') {
    const endpoint = String(body.endpoint || '').trim();
    if (!endpoint) return res.status(400).json({ success: false, message: 'endpoint is verplicht.' });
    const removed = await removeSubscriptionByEndpoint(endpoint);
    return res.status(200).json({ success: true, removed });
  }

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST of DELETE.' });

  const sub = body.subscription || body;
  const endpoint = String(sub?.endpoint || '').trim();
  if (!endpoint) return res.status(400).json({ success: false, message: 'subscription.endpoint is verplicht.' });

  try {
    const saved = await upsertSubscription({
      store: body.store,
      personnelId: body.personnelId,
      endpoint,
      keys: sub.keys || {},
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200)
    });
    return res.status(200).json({ success: true, subscription: { id: saved.id, store: saved.store } });
  } catch (error) {
    console.error('[push/subscribe]', error);
    return res.status(500).json({ success: false, message: error.message || 'Subscription opslaan mislukt.' });
  }
}
