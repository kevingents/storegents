import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  upsertSubscription,
  removeSubscriptionByEndpoint,
  getAllSubscriptions,
} from '../../lib/push-subscriptions-store.js';
import { vapidPublicKey, pushConfigured, sendPushToSubscriptions } from '../../lib/web-push-sender.js';

/**
 * /api/me/push — web-push voor de ingelogde gebruiker.
 *   GET                         → { publicKey, configured }   (VAPID public key om te abonneren)
 *   POST { subscription, store }→ abonneren (PushSubscription opslaan)
 *   POST { test:true }          → testmelding naar de eigen apparaten
 *   DELETE ?endpoint= / POST {unsubscribe} → afmelden
 *
 * Identiteit via x-user-id (door de BFF gezet). Geen admin-token nodig.
 */

const clean = (v) => String(v == null ? '' : v).trim();

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'GET') {
    return res.status(200).json({ success: true, publicKey: vapidPublicKey(), configured: pushConfigured() });
  }

  const userId = clean(req.headers['x-user-id'] || req.query.userId);
  const body = parseBody(req);

  if (req.method === 'DELETE' || body.unsubscribe) {
    const endpoint = clean(body.endpoint || body.unsubscribe || req.query.endpoint);
    const removed = await removeSubscriptionByEndpoint(endpoint);
    return res.status(200).json({ success: true, removed });
  }

  if (req.method === 'POST') {
    /* Testmelding naar de eigen apparaten. */
    if (body.test) {
      const all = await getAllSubscriptions();
      const mine = userId ? all.filter((s) => String(s.personnelId) === String(userId)) : all;
      if (!mine.length) return res.status(200).json({ success: false, message: 'Nog geen apparaat aangemeld.' });
      const r = await sendPushToSubscriptions(mine, {
        title: 'GENTS Portaal',
        body: 'Testmelding — push werkt op dit apparaat.',
        url: '/dashboard',
        tag: 'gents-test',
      });
      return res.status(200).json({ success: r.sent > 0, ...r });
    }

    const sub = body.subscription || body;
    if (!sub || !sub.endpoint) {
      return res.status(400).json({ success: false, message: 'subscription.endpoint ontbreekt.' });
    }
    const saved = await upsertSubscription({
      store: clean(body.store),
      personnelId: userId,
      endpoint: sub.endpoint,
      keys: sub.keys,
      userAgent: clean(req.headers['user-agent']),
    });
    return res.status(200).json({ success: true, id: saved.id, configured: pushConfigured() });
  }

  return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
}
