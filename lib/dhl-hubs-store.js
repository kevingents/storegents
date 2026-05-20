/**
 * DHL hub-overrides per winkel (admin-instellingen).
 *
 * In `lib/dhl-hubs.js` staan de defaults op basis van de Excel-contactgegevens.
 * Hier kan admin per winkel afwijkende waarden instellen die voorrang krijgen.
 *
 * Schema:
 *   {
 *     "GENTS Almere": {
 *       hub: "RH Amersfoort",
 *       email: "boq.ame@dhl.com",
 *       phone: "06-51174489",
 *       pickupWindow: "15:00 - 17:00",
 *       pickupAddress: "Stadhuisstraat 4, 1315HC Almere",
 *       updatedAt: "2026-05-20T08:30:00.000Z",
 *       updatedBy: "admin"
 *     },
 *     ...
 *   }
 *
 * Alleen velden die in de override staan worden gemerged met de defaults.
 * Een lege object = "verwijder override, gebruik default weer".
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'config/dhl-hubs.json';

async function readBlobText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('DHL hub-config kon niet worden gelezen.');
  return response.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = (result.blobs || []).find((b) => b.pathname === STORE_PATH);
    if (!blob) return {};
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    console.error('[dhl-hubs-store] read error:', error);
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
 * Hele override-map ophalen (alleen velden die admin heeft aangepast).
 */
export async function getAllDhlHubOverrides() {
  return loadAll();
}

/**
 * Override voor specifieke winkel ophalen.
 */
export async function getDhlHubOverride(store) {
  const map = await loadAll();
  const target = String(store || '').trim();
  if (!target) return null;
  if (map[target]) return map[target];
  /* Case-insensitive */
  const lc = target.toLowerCase();
  const key = Object.keys(map).find((k) => k.toLowerCase() === lc);
  return key ? map[key] : null;
}

/**
 * Override opslaan/updaten voor een winkel.
 * Geef `null` of leeg object om de override te verwijderen (default weer actief).
 */
export async function setDhlHubOverride(store, override, updatedBy = 'admin') {
  const target = String(store || '').trim();
  if (!target) throw new Error('Winkel-naam ontbreekt.');

  const map = await loadAll();

  if (!override || (typeof override === 'object' && !Object.keys(override).length)) {
    delete map[target];
    await saveAll(map);
    return { store: target, removed: true };
  }

  const clean = {};
  const allowed = ['hub', 'email', 'phone', 'pickupWindow', 'pickupAddress', 'registeredSince'];
  for (const key of allowed) {
    if (override[key] !== undefined && override[key] !== null) {
      const val = String(override[key]).trim();
      if (val) clean[key] = val;
    }
  }

  /* Email validatie */
  if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
    throw new Error('Ongeldig depot e-mailadres.');
  }

  clean.updatedAt = new Date().toISOString();
  clean.updatedBy = String(updatedBy || 'admin');

  map[target] = clean;
  await saveAll(map);
  return { store: target, override: clean };
}

/**
 * Bulk-update: meerdere winkels tegelijk overschrijven.
 * Items met lege/null override worden verwijderd (default actief).
 */
export async function bulkSetDhlHubOverrides(updates, updatedBy = 'admin') {
  if (!updates || typeof updates !== 'object') throw new Error('Geen updates ontvangen.');
  const map = await loadAll();
  const applied = [];
  const now = new Date().toISOString();
  const allowed = ['hub', 'email', 'phone', 'pickupWindow', 'pickupAddress', 'registeredSince'];

  for (const [store, override] of Object.entries(updates)) {
    const target = String(store || '').trim();
    if (!target) continue;

    if (!override || (typeof override === 'object' && !Object.keys(override).length)) {
      delete map[target];
      applied.push({ store: target, removed: true });
      continue;
    }

    const clean = {};
    for (const key of allowed) {
      if (override[key] !== undefined && override[key] !== null) {
        const val = String(override[key]).trim();
        if (val) clean[key] = val;
      }
    }

    if (clean.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email)) {
      throw new Error(`Ongeldig email voor ${target}: ${clean.email}`);
    }

    clean.updatedAt = now;
    clean.updatedBy = String(updatedBy || 'admin');
    map[target] = clean;
    applied.push({ store: target, override: clean });
  }

  await saveAll(map);
  return { applied, count: applied.length };
}
