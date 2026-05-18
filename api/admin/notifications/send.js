/**
 * POST /api/admin/notifications/send
 *
 * Body: { stores: ['GENTS Amsterdam', ...] | ['*'], target, title, body, severity, link }
 *
 * Persistt notificatie in store-notifications-store. Probeert daarnaast
 * push-notificaties te versturen naar geregistreerde browsers van die
 * winkels (web-push). Beide werken onafhankelijk:
 *   - In-page polling van /api/notifications/unread ziet hem altijd
 *   - Push komt aan als de browser de SW heeft geregistreerd
 */

import { createNotification } from '../../../lib/store-notifications-store.js';
import { getSubscriptionsForStores, removeSubscriptionByEndpoint } from '../../../lib/push-subscriptions-store.js';
import { sendPushToStores, pushowlConfigured } from '../../../lib/pushowl-client.js';
import { requireSystemAdmin } from '../../../lib/permission-guards.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

async function sendPush(subscription, payload) {
  /* Dynamic import van web-push zodat het optioneel is */
  try {
    const webpush = await import('web-push');
    const wp = webpush.default || webpush;
    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    const vapidSubject = process.env.VAPID_SUBJECT || 'mailto:klantenservice@gents.nl';
    if (!vapidPublic || !vapidPrivate) return { sent: false, reason: 'VAPID-keys ontbreken' };

    wp.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    await wp.sendNotification({
      endpoint: subscription.endpoint,
      keys: subscription.keys
    }, JSON.stringify(payload));
    return { sent: true };
  } catch (error) {
    /* 410 / 404 → subscription expired, cleanup */
    if (error.statusCode === 410 || error.statusCode === 404) {
      await removeSubscriptionByEndpoint(subscription.endpoint).catch(() => {});
      return { sent: false, reason: 'expired', removed: true };
    }
    return { sent: false, reason: error.message };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireSystemAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  const body = parseBody(req);
  const stores = Array.isArray(body.stores) ? body.stores.filter(Boolean) : (body.target === 'all' || !body.target ? ['*'] : [String(body.target)]);
  const title = String(body.title || '').trim();
  const text = String(body.body || '').trim();
  if (!title) return res.status(400).json({ success: false, message: 'title is verplicht.' });
  if (!text) return res.status(400).json({ success: false, message: 'body is verplicht.' });

  const actor = String(req.headers['x-actor'] || body.actor || 'admin').trim() || 'admin';

  try {
    const notification = await createNotification({
      stores,
      target: stores.includes('*') ? 'all' : (stores.length === 1 ? stores[0] : 'multi'),
      title,
      body: text,
      severity: body.severity || 'info',
      link: body.link || '',
      createdBy: actor
    });

    /* Push verzenden in parallel — best-effort.
       Twee paden:
         - Web Push (eigen VAPID + SW) — werkt niet binnen Shopify-storefront
         - PushOwl (Shopify-app SW) — werkt wel binnen Shopify */
    let webPushResults = { attempted: 0, sent: 0, removed: 0 };
    try {
      const subs = await getSubscriptionsForStores(stores);
      webPushResults.attempted = subs.length;
      const results = await Promise.all(subs.map((s) => sendPush(s, {
        id: notification.id,
        title, body: text, severity: notification.severity, link: notification.link
      })));
      webPushResults.sent = results.filter((r) => r.sent).length;
      webPushResults.removed = results.filter((r) => r.removed).length;
    } catch (e) {
      console.error('[notifications/send] web-push fail:', e);
    }

    let pushowlResult = { sent: false, reason: 'not-attempted' };
    if (pushowlConfigured()) {
      try {
        pushowlResult = await sendPushToStores(stores, {
          title, body: text, url: notification.link || 'https://gents.nl/pages/winkel-portaal'
        });
      } catch (e) {
        pushowlResult = { sent: false, reason: e.message };
        console.error('[notifications/send] pushowl fail:', e);
      }
    } else {
      pushowlResult = { sent: false, reason: 'PUSHOWL_API_KEY niet ingesteld' };
    }

    return res.status(200).json({
      success: true,
      notification,
      push: webPushResults,
      pushowl: pushowlResult
    });
  } catch (error) {
    console.error('[notifications/send]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
