/**
 * Watermark store voor cron-based notification triggers.
 * Houdt bij welke order-id's al genotificeerd zijn zodat we niet dubbele
 * meldingen sturen.
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'notifications/watermarks.json';
let __CACHE__ = null;
let __CACHE_AT__ = 0;
const CACHE_TTL_MS = 10 * 1000;

async function readBlobText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Blob read: ${r.status}`);
  return r.text();
}

export async function getWatermarks({ refresh = false } = {}) {
  if (!refresh && __CACHE__ && (Date.now() - __CACHE_AT__) < CACHE_TTL_MS) return __CACHE__;
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STORE_PATH);
    if (!blob) { __CACHE__ = {}; __CACHE_AT__ = Date.now(); return __CACHE__; }
    const raw = await readBlobText(blob.url);
    __CACHE__ = JSON.parse(raw || '{}') || {};
    __CACHE_AT__ = Date.now();
    return __CACHE__;
  } catch (e) {
    console.error('[notifications-watermark-store]', e);
    return __CACHE__ || {};
  }
}

async function writeAll(data) {
  await put(STORE_PATH, JSON.stringify(data, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 10
  });
  __CACHE__ = data;
  __CACHE_AT__ = Date.now();
}

/**
 * @param key e.g. 'pickup-orders' | 'weborders' | 'returns'
 * @returns Set<string> of seen ids for this key
 */
export async function getSeenIds(key) {
  const all = await getWatermarks();
  return new Set(all[key]?.seenIds || []);
}

export async function markSeen(key, ids = [], maxRetained = 500) {
  if (!ids || !ids.length) return;
  const all = await getWatermarks({ refresh: true });
  const cur = all[key] || { seenIds: [], updatedAt: null };
  const set = new Set(cur.seenIds || []);
  for (const id of ids) set.add(String(id));
  /* Hardcap zodat de file niet onbeperkt groeit */
  let arr = [...set];
  if (arr.length > maxRetained) arr = arr.slice(-maxRetained);
  all[key] = { seenIds: arr, updatedAt: new Date().toISOString() };
  await writeAll(all);
}
