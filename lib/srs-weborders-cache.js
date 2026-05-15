import { list, put } from '@vercel/blob';

const CACHE_PREFIX = 'srs-cache/open-weborders/';
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minuten

function storeToKey(store) {
  return store
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function cachePath(store) {
  return `${CACHE_PREFIX}${storeToKey(store)}.json`;
}

async function readBlob(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Blob lezen mislukt: ${res.status}`);
  return res.text();
}

export async function getCachedWeborders(store) {
  try {
    const path = cachePath(store);
    const result = await list({ prefix: path, limit: 1 });
    const blob = (result.blobs || []).find((b) => b.pathname === path);
    if (!blob) return null;

    const raw = await readBlob(blob.url);
    const data = JSON.parse(raw || 'null');
    if (!data) return null;

    const age = Date.now() - new Date(data.cachedAt || 0).getTime();
    return { ...data, stale: age > CACHE_TTL_MS, ageMs: age };
  } catch {
    return null;
  }
}

export async function setCachedWeborders(store, payload) {
  const path = cachePath(store);
  const entry = { ...payload, cachedAt: new Date().toISOString() };
  await put(path, JSON.stringify(entry), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}
