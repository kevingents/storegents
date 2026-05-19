/**
 * Winkel-emails configuratie.
 *
 * Blob-store met per winkel een mail-adres voor automatische notificaties
 * (reservering-verloop, facilitair-status, niet-leverbaar alerts, etc).
 *
 * Voorheen via env vars (FACILITAIR_STORE_MAIL_GENTS_TILBURG=...) — nu
 * configureerbaar via admin-portal. Env-vars werken nog als fallback voor
 * winkels die niet in de Blob staan.
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'config/store-emails.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Winkel-emails kunnen niet worden gelezen.');
  return response.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === STORE_PATH);
    if (!blob) return {};
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('[store-emails-store] read error:', error);
    return {};
  }
}

async function saveAll(map) {
  await put(STORE_PATH, JSON.stringify(map, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
}

/**
 * Krijg het mail-adres voor een winkel. Volgorde:
 *   1. Blob-configuratie (per winkel)
 *   2. Env var FACILITAIR_STORE_MAIL_<STORE_KEY>
 *   3. Env var FACILITAIR_STORE_MAIL_DEFAULT
 *   4. Env var STORE_MAIL
 *   5. '' (geen mail mogelijk)
 */
export async function getEmailForStore(storeName) {
  const target = String(storeName || '').trim();
  if (!target) return '';
  const map = await loadAll();
  if (map[target]) return String(map[target]).trim();
  const key = target.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return (
    process.env[`FACILITAIR_STORE_MAIL_${key}`] ||
    process.env.FACILITAIR_STORE_MAIL_DEFAULT ||
    process.env.STORE_MAIL ||
    ''
  );
}

export async function getAllStoreEmails() {
  const map = await loadAll();
  /* Voeg env-fallback-info toe zodat admin ziet welke nog niet handmatig gezet zijn. */
  return map;
}

export async function setStoreEmail(storeName, email) {
  const target = String(storeName || '').trim();
  if (!target) throw new Error('Winkel-naam ontbreekt.');
  const clean = String(email || '').trim();
  if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
    throw new Error('Ongeldig e-mailadres.');
  }
  const map = await loadAll();
  if (!clean) {
    delete map[target];
  } else {
    map[target] = clean;
  }
  await saveAll(map);
  return { store: target, email: clean };
}

export async function bulkSetStoreEmails(updates) {
  if (!updates || typeof updates !== 'object') throw new Error('Geen updates ontvangen.');
  const map = await loadAll();
  const applied = [];
  for (const [store, email] of Object.entries(updates)) {
    const target = String(store || '').trim();
    if (!target) continue;
    const clean = String(email || '').trim();
    if (clean && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) {
      throw new Error(`Ongeldig e-mailadres voor ${target}: ${clean}`);
    }
    if (!clean) delete map[target];
    else map[target] = clean;
    applied.push({ store: target, email: clean });
  }
  await saveAll(map);
  return { applied, count: applied.length };
}
