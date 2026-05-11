import { list, put } from '@vercel/blob';

const CACHE_PREFIX = 'reports/cache';
const DEFAULT_TTL_MS = Number(process.env.REPORT_CACHE_TTL_MS || 15 * 60 * 1000);

function cleanPart(value) {
  return String(value || 'default').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

export function reportCachePath(name, key) {
  return `${CACHE_PREFIX}/${cleanPart(name)}/${cleanPart(key)}.json`;
}

async function readText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Rapportagecache kon niet worden gelezen.');
  return response.text();
}

export async function getReportCache(name, key, ttlMs = DEFAULT_TTL_MS) {
  try {
    const pathname = reportCachePath(name, key);
    const result = await list({ prefix: pathname, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === pathname);
    if (!blob) return null;
    const payload = JSON.parse((await readText(blob.url)) || '{}');
    const ageMs = Date.now() - new Date(payload.cachedAt || 0).getTime();
    if (ttlMs > 0 && ageMs > ttlMs) return { ...payload, stale: true, ageMs };
    return { ...payload, stale: false, ageMs };
  } catch (error) {
    console.error('[report cache read]', error);
    return null;
  }
}

export async function setReportCache(name, key, data, meta = {}) {
  const payload = {
    success: true,
    cachedAt: new Date().toISOString(),
    name,
    key,
    meta,
    data
  };
  await put(reportCachePath(name, key), JSON.stringify(payload, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  return payload;
}
