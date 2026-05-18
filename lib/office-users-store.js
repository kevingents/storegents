/**
 * Office users store — Vercel Blob-backed.
 *
 * Voor kantoor-gebruikers / externen die GEEN SRS kassa-login hebben maar
 * wel toegang nodig hebben tot delen van de admin portal (finance, marketing,
 * support enz.).
 *
 * Login-flow voor deze users: ADMIN_PIN + email-match (in plaats van
 * personeelsnummer + posLoginCode).
 *
 * Storage:
 *   admin/office-users.json = {
 *     [userId]: {
 *       userId: 'office-{slug}',          // unique key
 *       name: 'Volledige naam',
 *       email: 'iemand@gents.nl',         // primary identifier voor login
 *       phone: '',
 *       department: 'Finance',
 *       active: true,
 *       createdAt: ISO,
 *       updatedAt: ISO,
 *       createdBy: 'admin'
 *     }
 *   }
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'admin/office-users.json';
let __CACHE__ = null;
let __CACHE_AT__ = 0;
const CACHE_TTL_MS = 30 * 1000;

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Blob read mislukt: ${response.status}`);
  return response.text();
}

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/@/g, '-at-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export function makeOfficeUserId(email) {
  const slug = slugify(email);
  return `office-${slug || 'unknown'}`;
}

export async function getAllOfficeUsers({ refresh = false } = {}) {
  if (!refresh && __CACHE__ && (Date.now() - __CACHE_AT__) < CACHE_TTL_MS) {
    return __CACHE__;
  }
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STORE_PATH);
    if (!blob) { __CACHE__ = {}; __CACHE_AT__ = Date.now(); return __CACHE__; }
    const raw = await readBlobText(blob.url);
    __CACHE__ = JSON.parse(raw || '{}') || {};
    __CACHE_AT__ = Date.now();
    return __CACHE__;
  } catch (error) {
    console.error('[office-users-store]', error);
    return __CACHE__ || {};
  }
}

async function writeAll(data) {
  await put(STORE_PATH, JSON.stringify(data, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  __CACHE__ = data; __CACHE_AT__ = Date.now();
}

export async function upsertOfficeUser(input = {}, createdBy = 'admin') {
  const email = String(input.email || '').trim().toLowerCase();
  if (!email) throw new Error('email is verplicht voor een kantoor-gebruiker');
  if (!input.name) throw new Error('name is verplicht');

  const userId = input.userId || makeOfficeUserId(email);
  const all = await getAllOfficeUsers({ refresh: true });
  const existing = all[userId] || {};

  const now = new Date().toISOString();
  const updated = {
    userId,
    name: String(input.name).trim(),
    email,
    phone: input.phone ?? existing.phone ?? '',
    department: input.department ?? existing.department ?? '',
    active: input.active !== undefined ? Boolean(input.active) : (existing.active !== undefined ? existing.active : true),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    createdBy: existing.createdBy || String(createdBy || 'admin')
  };
  all[userId] = updated;
  await writeAll(all);
  return updated;
}

export async function deleteOfficeUser(userId) {
  if (!userId) return false;
  const all = await getAllOfficeUsers({ refresh: true });
  if (!(userId in all)) return false;
  delete all[userId];
  await writeAll(all);
  return true;
}

export async function findOfficeUserByEmail(email) {
  if (!email) return null;
  const clean = String(email).toLowerCase().trim();
  const all = await getAllOfficeUsers();
  return Object.values(all).find((u) => String(u.email || '').toLowerCase() === clean) || null;
}
