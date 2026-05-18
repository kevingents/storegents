/**
 * Audit log voor user-permissions mutations.
 *
 * Storage: admin/permissions-audit.json = [
 *   {
 *     id, at, actor, action: 'upsert'|'delete'|'create-office'|'delete-office',
 *     targetUserId, targetName, before, after, changes: [...keys]
 *   }
 * ]
 *
 * Hardcap 1000 events (oudste worden weggeknipt).
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'admin/permissions-audit.json';
const MAX_ENTRIES = 1000;
let __CACHE__ = null;
let __CACHE_AT__ = 0;
const CACHE_TTL_MS = 15 * 1000;

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Blob read mislukt: ${response.status}`);
  return response.text();
}

export async function getAuditLog({ limit = 100, refresh = false } = {}) {
  if (!refresh && __CACHE__ && (Date.now() - __CACHE_AT__) < CACHE_TTL_MS) {
    return __CACHE__.slice(0, limit);
  }
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STORE_PATH);
    if (!blob) { __CACHE__ = []; __CACHE_AT__ = Date.now(); return []; }
    const raw = await readBlobText(blob.url);
    __CACHE__ = JSON.parse(raw || '[]');
    if (!Array.isArray(__CACHE__)) __CACHE__ = [];
    __CACHE_AT__ = Date.now();
    return __CACHE__.slice(0, limit);
  } catch (error) {
    console.error('[permissions-audit-store]', error);
    return __CACHE__ || [];
  }
}

function diffKeys(before = {}, after = {}) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  const changes = [];
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) changes.push(k);
  }
  return changes;
}

export async function appendAuditEntry(entry = {}) {
  const all = await getAuditLog({ limit: MAX_ENTRIES, refresh: true });
  const item = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: new Date().toISOString(),
    actor: String(entry.actor || 'admin').trim(),
    action: String(entry.action || 'upsert').trim(),
    targetUserId: String(entry.targetUserId || '').trim(),
    targetName: String(entry.targetName || '').trim(),
    before: entry.before || null,
    after: entry.after || null,
    changes: entry.changes || diffKeys(entry.before, entry.after),
    note: entry.note || ''
  };
  const next = [item, ...all].slice(0, MAX_ENTRIES);
  await put(STORE_PATH, JSON.stringify(next, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
  __CACHE__ = next; __CACHE_AT__ = Date.now();
  return item;
}
