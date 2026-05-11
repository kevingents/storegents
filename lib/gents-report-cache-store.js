import { list, put } from '@vercel/blob';

const PREFIX = 'reports-cache';
const DEFAULT_TTL_MS = 900000;

function safe(value) {
  return String(value || 'default')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
}

function pathFor(name, key) {
  return `${PREFIX}/${safe(name)}/${safe(key)}.json`;
}

async function readText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Cache lezen mislukt.');
  return response.text();
}

export async function readReportCache(name, key, ttlMs = DEFAULT_TTL_MS) {
  try {
    const pathname = pathFor(name, key);
    const result = await list({ prefix: pathname, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === pathname);
    if (!blob) return null;
    const payload = JSON.parse((await readText(blob.url)) || '{}');
    const cachedAtMs = new Date(payload.cachedAt || 0).getTime();
    const ageMs = Date.now() - cachedAtMs;
    return { ...payload, ageMs, stale: ttlMs > 0 && ageMs > ttlMs };
  } catch (error) {
    console.error('[report-cache-read]', error);
    return null;
  }
}

export async function writeReportCache(name, key, data) {
  const payload = {
    cachedAt: new Date().toISOString(),
    name,
    key,
    data
  };
  await put(pathFor(name, key), JSON.stringify(payload), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  return payload;
}
