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

/* Extract IP-adres + user-agent + locatie uit een req-object voor audit-log */
export function extractRequestMeta(req) {
  if (!req || !req.headers) return null;
  const headers = req.headers;
  const xff = String(headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xff || headers['x-real-ip'] || headers['cf-connecting-ip'] || req.socket?.remoteAddress || '';
  return {
    ip: String(ip || '').trim(),
    userAgent: String(headers['user-agent'] || '').trim().slice(0, 300),
    /* Vercel/Cloudflare geo-headers — als beschikbaar */
    country: String(headers['x-vercel-ip-country'] || headers['cf-ipcountry'] || '').trim(),
    city: String(headers['x-vercel-ip-city'] || headers['cf-ipcity'] || '').trim(),
    region: String(headers['x-vercel-ip-country-region'] || '').trim()
  };
}

/* Compacte user-agent → leesbaar device-label */
export function summarizeUserAgent(ua = '') {
  const u = String(ua || '');
  if (!u) return '';
  let browser = 'Browser';
  if (/Edg\//.test(u)) browser = 'Edge';
  else if (/Chrome\//.test(u) && !/Chromium/.test(u)) browser = 'Chrome';
  else if (/Firefox\//.test(u)) browser = 'Firefox';
  else if (/Safari\//.test(u) && !/Chrome/.test(u)) browser = 'Safari';
  let os = '';
  if (/Windows NT/.test(u)) os = 'Windows';
  else if (/Mac OS X/.test(u)) os = 'macOS';
  else if (/Android/.test(u)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(u)) os = 'iOS';
  else if (/Linux/.test(u)) os = 'Linux';
  return os ? `${browser} · ${os}` : browser;
}

export async function appendAuditEntry(entry = {}) {
  const all = await getAuditLog({ limit: MAX_ENTRIES, refresh: true });
  const meta = entry.request ? extractRequestMeta(entry.request) : entry.meta || null;
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
    note: entry.note || '',
    /* Request metadata (IP, UA, geo) — optioneel; voor login-events ingevuld */
    meta: meta ? {
      ip: meta.ip || '',
      userAgent: meta.userAgent || '',
      device: summarizeUserAgent(meta.userAgent),
      country: meta.country || '',
      city: meta.city || '',
      region: meta.region || ''
    } : null
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
