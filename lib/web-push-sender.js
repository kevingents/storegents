/**
 * Web-push verzender (VAPID). De PUBLIEKE sleutel staat als default ingebakken
 * (niet-secret); de PRIVÉ-sleutel komt uit Vercel env VAPID_PRIVATE_KEY (secret).
 * Zonder privé-sleutel is push 'niet geconfigureerd' en wordt er niets verstuurd.
 */

import webpush from 'web-push';
import {
  getAllSubscriptions,
  getSubscriptionsForStores,
  removeSubscriptionByEndpoint,
} from './push-subscriptions-store.js';

/* Publieke sleutel = gegenereerd paar; overschrijfbaar via env. */
const PUBLIC_KEY =
  process.env.VAPID_PUBLIC_KEY ||
  'BD3Hdy6-EyPtaaVWBxLFKezxvwZTlRBmrGxiOg_GpJIKa39aPUVKb1dXeIIAp0U1083zLXqT8-rwlNrTdSGyR7o';
const PRIVATE_KEY = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:administratie@gents.nl';

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  if (!PRIVATE_KEY) return false;
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY);
  configured = true;
  return true;
}

export function pushConfigured() {
  return Boolean(PRIVATE_KEY);
}

export function vapidPublicKey() {
  return PUBLIC_KEY;
}

/** Stuur een notificatie naar een lijst subscriptions. Ruimt dode subs op (404/410). */
export async function sendPushToSubscriptions(subs, payload) {
  if (!ensureConfigured()) return { sent: 0, failed: 0, configured: false };
  const body = JSON.stringify(payload || {});
  let sent = 0;
  let failed = 0;
  await Promise.all(
    (subs || []).map(async (s) => {
      if (!s?.endpoint || !s?.keys) return;
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body);
        sent += 1;
      } catch (e) {
        failed += 1;
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await removeSubscriptionByEndpoint(s.endpoint).catch(() => {});
        }
      }
    })
  );
  return { sent, failed, configured: true };
}

/** Stuur naar alle subscriptions van bepaalde winkels ('*' of leeg = iedereen). */
export async function sendPushToStores(stores, payload) {
  const subs = await getSubscriptionsForStores(stores);
  return sendPushToSubscriptions(subs, payload);
}

/** Stuur naar álle subscriptions. */
export async function sendPushToAll(payload) {
  const subs = await getAllSubscriptions();
  return sendPushToSubscriptions(subs, payload);
}
