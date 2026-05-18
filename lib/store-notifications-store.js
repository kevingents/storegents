/**
 * Store notifications — Vercel Blob-backed.
 *
 * Per notificatie:
 *   { id, target: 'all'|<store>|<store>[], stores: [...], title, body,
 *     severity: 'info'|'success'|'warning'|'danger',
 *     link, createdAt, createdBy,
 *     readBy: { [store]: ISO } }
 *
 * Hardcap 500 events.
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'notifications/store-notifications.json';
const MAX_ENTRIES = 500;
let __CACHE__ = null;
let __CACHE_AT__ = 0;
const CACHE_TTL_MS = 10 * 1000;

async function readBlobText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Blob read mislukt: ${r.status}`);
  return r.text();
}

export async function getAllNotifications({ refresh = false } = {}) {
  if (!refresh && __CACHE__ && (Date.now() - __CACHE_AT__) < CACHE_TTL_MS) {
    return __CACHE__;
  }
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STORE_PATH);
    if (!blob) { __CACHE__ = []; __CACHE_AT__ = Date.now(); return []; }
    const raw = await readBlobText(blob.url);
    __CACHE__ = JSON.parse(raw || '[]');
    if (!Array.isArray(__CACHE__)) __CACHE__ = [];
    __CACHE_AT__ = Date.now();
    return __CACHE__;
  } catch (error) {
    console.error('[store-notifications-store]', error);
    return __CACHE__ || [];
  }
}

async function writeAll(items) {
  await put(STORE_PATH, JSON.stringify(items, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 15
  });
  __CACHE__ = items; __CACHE_AT__ = Date.now();
}

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function createNotification(input = {}) {
  const all = await getAllNotifications({ refresh: true });
  const stores = Array.isArray(input.stores) && input.stores.length
    ? input.stores.map(String)
    : (input.target === 'all' || !input.target ? ['*'] : [String(input.target)]);

  const item = {
    id: genId(),
    target: input.target || (stores.includes('*') ? 'all' : (stores.length === 1 ? stores[0] : 'multi')),
    stores,
    title: String(input.title || '').slice(0, 200),
    body:  String(input.body  || '').slice(0, 2000),
    severity: ['info','success','warning','danger'].includes(input.severity) ? input.severity : 'info',
    link: String(input.link || '').slice(0, 500),
    createdAt: new Date().toISOString(),
    createdBy: String(input.createdBy || 'admin'),
    readBy: {}
  };

  const next = [item, ...all].slice(0, MAX_ENTRIES);
  await writeAll(next);
  return item;
}

export async function listForStore(store, { limit = 50, includeRead = false } = {}) {
  const all = await getAllNotifications();
  const s = String(store || '').trim();
  if (!s) return [];

  const filtered = all.filter((n) => {
    if (!n.stores) return false;
    if (n.stores.includes('*')) return true;
    return n.stores.map(String).includes(s);
  }).filter((n) => {
    if (includeRead) return true;
    return !n.readBy?.[s];
  });

  return filtered.slice(0, limit);
}

export async function markRead(store, ids = []) {
  if (!store || !ids || !ids.length) return 0;
  const all = await getAllNotifications({ refresh: true });
  const idSet = new Set(ids.map(String));
  const now = new Date().toISOString();
  let count = 0;
  const next = all.map((n) => {
    if (!idSet.has(n.id)) return n;
    if (!n.readBy) n.readBy = {};
    if (!n.readBy[store]) { n.readBy[store] = now; count++; }
    return n;
  });
  if (count > 0) await writeAll(next);
  return count;
}

export async function markAllRead(store) {
  if (!store) return 0;
  const all = await getAllNotifications({ refresh: true });
  const now = new Date().toISOString();
  let count = 0;
  const next = all.map((n) => {
    if (!n.stores) return n;
    const matches = n.stores.includes('*') || n.stores.map(String).includes(String(store));
    if (!matches) return n;
    if (!n.readBy) n.readBy = {};
    if (!n.readBy[store]) { n.readBy[store] = now; count++; }
    return n;
  });
  if (count > 0) await writeAll(next);
  return count;
}

export async function deleteNotification(id) {
  if (!id) return false;
  const all = await getAllNotifications({ refresh: true });
  const next = all.filter((n) => n.id !== id);
  if (next.length === all.length) return false;
  await writeAll(next);
  return true;
}
