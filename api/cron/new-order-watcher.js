/**
 * Cron: GET /api/cron/new-order-watcher
 * Schedule: elke 5 minuten
 *
 * Detecteert NIEUWE afhaalorders + open weborders sinds vorige run en
 * stuurt een notificatie naar de betreffende winkel.
 *
 * Werkwijze:
 *   1. Loop alle GENTS-winkels langs
 *   2. Per winkel: fetch /api/pickup-orders en /api/srs/open-weborders
 *   3. Vergelijk met watermark store (seen order-ids per winkel)
 *   4. Voor nieuwe orders → createNotification + push (best-effort)
 *
 * Env-vars:
 *   ADMIN_TOKEN            - voor internal API calls
 *   CRON_SECRET (optional) - extra auth voor cron
 */

import { createNotification } from '../../lib/store-notifications-store.js';
import { getSubscriptionsForStores, removeSubscriptionByEndpoint } from '../../lib/push-subscriptions-store.js';
import { sendPushToStores, pushowlConfigured } from '../../lib/pushowl-client.js';
import { getSeenIds, markSeen } from '../../lib/notifications-watermark-store.js';
import { listBranches } from '../../lib/branch-metrics.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

function isAuthorized(req) {
  return isCronAuthorized(req);
}

async function sendPushBestEffort(subscription, payload) {
  try {
    const webpush = await import('web-push');
    const wp = webpush.default || webpush;
    const vapidPublic = process.env.VAPID_PUBLIC_KEY;
    const vapidPrivate = process.env.VAPID_PRIVATE_KEY;
    if (!vapidPublic || !vapidPrivate) return { sent: false, reason: 'no-vapid' };
    wp.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:klantenservice@gents.nl', vapidPublic, vapidPrivate);
    await wp.sendNotification(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify(payload)
    );
    return { sent: true };
  } catch (error) {
    if (error.statusCode === 410 || error.statusCode === 404) {
      await removeSubscriptionByEndpoint(subscription.endpoint).catch(() => {});
      return { sent: false, reason: 'expired', removed: true };
    }
    return { sent: false, reason: error.message };
  }
}

async function fetchInternal(req, path) {
  const host = req.headers['host'];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${host}`;
  const adminToken = process.env.ADMIN_TOKEN || '';
  const sep = path.includes('?') ? '&' : '?';
  const url = `${baseUrl}${path}${sep}adminToken=${encodeURIComponent(adminToken)}&t=${Date.now()}`;
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

async function checkStorePickups(req, store) {
  const result = { store, kind: 'pickup', newCount: 0, newIds: [] };
  try {
    const d = await fetchInternal(req, `/api/pickup-orders?store=${encodeURIComponent(store)}&status=open&days=14`);
    const orders = (d.orders || []).filter(o => !o.pickedUp && !o.cancelled);
    const seenKey = `pickup:${store}`;
    const seen = await getSeenIds(seenKey);
    const newOrders = orders.filter(o => {
      const id = String(o.id || o.orderId || o.name || o.orderNumber || '');
      return id && !seen.has(id);
    });
    result.newCount = newOrders.length;
    result.newIds = newOrders.map(o => String(o.id || o.orderId || o.name));
    if (newOrders.length) {
      const sample = newOrders.slice(0, 3).map(o => o.name || o.orderNumber).join(', ');
      const more = newOrders.length > 3 ? ` (+${newOrders.length - 3} meer)` : '';
      const notif = await createNotification({
        stores: [store],
        target: store,
        title: `${newOrders.length} nieuwe afhaalorder${newOrders.length > 1 ? 's' : ''}`,
        body: `${sample}${more} · Klanten wachten om hun bestelling op te halen.`,
        severity: 'info',
        link: '/pages/winkel-portaal',
        createdBy: 'cron:new-order-watcher'
      });
      /* Web Push (eigen SW) — werkt niet in Shopify maar best-effort */
      try {
        const subs = await getSubscriptionsForStores([store]);
        await Promise.all(subs.map(s => sendPushBestEffort(s, {
          id: notif.id, title: notif.title, body: notif.body, severity: notif.severity, link: notif.link
        })));
      } catch (e) { console.error('[push pickup]', e.message); }
      /* PushOwl push — werkt wel in Shopify */
      if (pushowlConfigured()) {
        try {
          await sendPushToStores([store], {
            title: notif.title, body: notif.body, url: 'https://gents.nl/pages/winkel-portaal'
          });
        } catch (e) { console.error('[pushowl pickup]', e.message); }
      }
      await markSeen(seenKey, result.newIds);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function checkStoreWeborders(req, store) {
  const result = { store, kind: 'weborder', newCount: 0, newIds: [] };
  try {
    const d = await fetchInternal(req, `/api/srs/open-weborders?store=${encodeURIComponent(store)}`);
    const orders = (d.requests || d.items || d.rows || []);
    const seenKey = `weborder:${store}`;
    const seen = await getSeenIds(seenKey);
    const newOrders = orders.filter(o => {
      const id = String(o.orderNr || o.shopifyOrderName || '');
      return id && !seen.has(id);
    });
    result.newCount = newOrders.length;
    result.newIds = newOrders.map(o => String(o.orderNr || o.shopifyOrderName));
    if (newOrders.length) {
      const sample = newOrders.slice(0, 3).map(o => o.orderNr || o.shopifyOrderName).join(', ');
      const more = newOrders.length > 3 ? ` (+${newOrders.length - 3} meer)` : '';
      const notif = await createNotification({
        stores: [store],
        target: store,
        title: `${newOrders.length} nieuwe weborder${newOrders.length > 1 ? 's' : ''}`,
        body: `${sample}${more} · Klaarmaken voor pick & pack.`,
        severity: 'info',
        link: '/pages/winkel-portaal',
        createdBy: 'cron:new-order-watcher'
      });
      try {
        const subs = await getSubscriptionsForStores([store]);
        await Promise.all(subs.map(s => sendPushBestEffort(s, {
          id: notif.id, title: notif.title, body: notif.body, severity: notif.severity, link: notif.link
        })));
      } catch (e) { console.error('[push weborder]', e.message); }
      if (pushowlConfigured()) {
        try {
          await sendPushToStores([store], {
            title: notif.title, body: notif.body, url: 'https://gents.nl/pages/winkel-portaal'
          });
        } catch (e) { console.error('[pushowl weborder]', e.message); }
      }
      await markSeen(seenKey, result.newIds);
    }
  } catch (error) {
    result.error = error.message;
  }
  return result;
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const branches = listBranches();
  const stores = branches.map(b => b.store).filter(Boolean);

  /* Optionele subset via query */
  const onlyStore = String(req.query.store || '').trim();
  const targets = onlyStore ? [onlyStore] : stores;

  /* Beperkte concurrency om SRS niet te overbelasten */
  const results = { pickup: [], weborder: [] };
  for (const store of targets) {
    try {
      results.pickup.push(await checkStorePickups(req, store));
      results.weborder.push(await checkStoreWeborders(req, store));
    } catch (e) {
      results.pickup.push({ store, error: e.message });
    }
  }

  const totals = {
    storesChecked: targets.length,
    newPickups:    results.pickup.reduce((s, r) => s + (r.newCount || 0), 0),
    newWeborders:  results.weborder.reduce((s, r) => s + (r.newCount || 0), 0)
  };

  return res.status(200).json({ success: true, totals, results });
}

export default trackedCron('new-order-watcher', handler);
