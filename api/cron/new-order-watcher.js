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
import { sendPushToStores as sendWebPush } from '../../lib/web-push-sender.js';
import { sendPushToStores, pushowlConfigured } from '../../lib/pushowl-client.js';
import { getSeenIds, markSeen } from '../../lib/notifications-watermark-store.js';
import { listBranches } from '../../lib/branch-metrics.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

function isAuthorized(req) {
  return isCronAuthorized(req);
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
      /* Web Push naar de portal-app (eigen SW) — speelt ook een bel (sound:true). */
      try {
        await sendWebPush([store], { title: notif.title, body: notif.body, url: '/openstaande-orders', tag: `pickup-${store}`, sound: true });
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

async function checkStoreWeborders(req, store, branchId = '', label = '') {
  const result = { store, kind: 'weborder', newCount: 0, newIds: [] };
  try {
    /* branchId-query is betrouwbaarder voor interne locaties (magazijn/uitlevertafel)
       die niet altijd op naam in de branch-config staan. */
    const q = branchId ? `branchId=${encodeURIComponent(branchId)}` : `store=${encodeURIComponent(store)}`;
    const d = await fetchInternal(req, `/api/srs/open-weborders?${q}`);
    const orders = (d.requests || d.items || d.rows || []);
    const seenKey = `weborder:${branchId || store}`;
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
        title: `${newOrders.length} nieuwe weborder${newOrders.length > 1 ? 's' : ''}${label ? ' · ' + label : ''}`,
        body: `${sample}${more} · Klaarmaken voor pick & pack.`,
        severity: 'info',
        link: '/pages/winkel-portaal',
        createdBy: 'cron:new-order-watcher'
      });
      try {
        await sendWebPush([store], { title: notif.title, body: notif.body, url: '/openstaande-orders', tag: `weborder-${store}`, sound: true });
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

  /* Magazijn + uitlevertafel: ALLEEN weborders (geen klant-afhaalorders), zodat
     ook die locaties een melding krijgen over hun open orders. Per branchId zodat
     de naam-mapping van de uitlevertafel geen probleem geeft. */
  if (!onlyStore) {
    const PIPELINE_LOCATIONS = [
      { notify: 'GENTS Magazijn', branchId: '99', label: 'Magazijn' },
      { notify: 'GENTS Magazijn', branchId: '97', label: 'Uitlevertafel' }
    ];
    for (const loc of PIPELINE_LOCATIONS) {
      try { results.weborder.push(await checkStoreWeborders(req, loc.notify, loc.branchId, loc.label)); }
      catch (e) { results.weborder.push({ store: loc.notify, error: e.message }); }
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
