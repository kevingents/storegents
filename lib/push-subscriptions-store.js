/**
 * Push subscriptions store — Vercel Blob-backed.
 *
 * Per subscription:
 *   { id, store, personnelId, endpoint, keys: { p256dh, auth },
 *     userAgent, createdAt, lastUsedAt }
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'notifications/push-subscriptions.json';
let __CACHE__ = null;
let __CACHE_AT__ = 0;
const CACHE_TTL_MS = 30 * 1000;

async function readBlobText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Blob read: ${r.status}`);
  return r.text();
}

export async function getAllSubscriptions({ refresh = false } = {}) {
  if (!refresh && __CACHE__ && (Date.now() - __CACHE_AT__) < CACHE_TTL_MS) return __CACHE__;
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STORE_PATH);
    if (!blob) { __CACHE__ = []; __CACHE_AT__ = Date.now(); return []; }
    const raw = await readBlobText(blob.url);
    __CACHE__ = JSON.parse(raw || '[]');
    if (!Array.isArray(__CACHE__)) __CACHE__ = [];
    __CACHE_AT__ = Date.now();
    return __CACHE__;
  } catch (e) {
    console.error('[push-subscriptions-store]', e);
    return __CACHE__ || [];
  }
}

async function writeAll(items) {
  await put(STORE_PATH, JSON.stringify(items, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
  __CACHE__ = items; __CACHE_AT__ = Date.now();
}

function fingerprint(endpoint) {
  return String(endpoint || '').split('/').pop().slice(0, 32);
}

export async function upsertSubscription({ store, personnelId, endpoint, keys, userAgent }) {
  if (!endpoint) throw new Error('endpoint is verplicht');
  const all = await getAllSubscriptions({ refresh: true });
  const id = fingerprint(endpoint);
  const existing = all.find((s) => s.id === id);
  const now = new Date().toISOString();

  if (existing) {
    existing.store = String(store || existing.store || '');
    existing.personnelId = String(personnelId || existing.personnelId || '');
    existing.keys = keys || existing.keys;
    existing.userAgent = userAgent || existing.userAgent;
    existing.lastUsedAt = now;
    await writeAll(all);
    return existing;
  }

  const sub = {
    id,
    store: String(store || ''),
    personnelId: String(personnelId || ''),
    endpoint,
    keys: keys || {},
    userAgent: String(userAgent || ''),
    createdAt: now,
    lastUsedAt: now
  };
  all.push(sub);
  await writeAll(all);
  return sub;
}

export async function removeSubscriptionByEndpoint(endpoint) {
  if (!endpoint) return false;
  const all = await getAllSubscriptions({ refresh: true });
  const id = fingerprint(endpoint);
  const next = all.filter((s) => s.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}

export async function getSubscriptionsForStores(stores = []) {
  const all = await getAllSubscriptions();
  if (!stores || !stores.length || stores.includes('*')) return all;
  const set = new Set(stores.map(String));
  return all.filter((s) => set.has(s.store));
}
