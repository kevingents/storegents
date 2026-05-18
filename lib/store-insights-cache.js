/**
 * Blob-cache voor pre-aggregated winkelinzicht.
 *
 * Layout:
 *   store-insights/<branchId>-<period>.json
 *
 * Wordt 's nachts geschreven door /api/cron/store-insights-builder en
 * gelezen door /api/admin/store-insights.
 */

import { put, list } from '@vercel/blob';

const BASE_PATH = 'store-insights';

function blobKey(branchId, period) {
  return `${BASE_PATH}/${String(branchId)}-${String(period)}.json`;
}

async function readBlobText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Blob read ${r.status}`);
  return r.text();
}

export async function readInsights(branchId, period) {
  if (!branchId || !period) return null;
  const path = blobKey(branchId, period);
  try {
    const result = await list({ prefix: path, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === path);
    if (!blob) return null;
    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || 'null');
  } catch (error) {
    console.error('[store-insights-cache] read fail:', branchId, period, error.message);
    return null;
  }
}

export async function writeInsights(branchId, period, payload) {
  if (!branchId || !period) return;
  const path = blobKey(branchId, period);
  await put(path, JSON.stringify({ ...payload, cachedAt: new Date().toISOString() }, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 24 * 3600 /* 24h cache hint */
  });
}

export async function listCachedKeys() {
  try {
    const result = await list({ prefix: BASE_PATH, limit: 1000 });
    return (result.blobs || []).map((b) => b.pathname);
  } catch (error) {
    return [];
  }
}
