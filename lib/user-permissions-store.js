/**
 * User permissions store — Vercel Blob-backed.
 *
 * Per personnelId slaan we op:
 *   {
 *     personnelId: string,
 *     role: 'admin' | 'regio_manager' | 'shop_manager' | 'medewerker' | 'office' | 'finance' | 'readonly',
 *     department: string,
 *     region: string,            // bv. 'Noord-Holland' (alleen bij regio_manager relevant)
 *     extraPermissions: string[], // extra grants bovenop role default
 *     revokedPermissions: string[], // explicit revoke
 *     notes: string,
 *     updatedAt: ISO string,
 *     updatedBy: string
 *   }
 *
 * Personnel zonder entry erven de default 'medewerker' role.
 */

import { put, list } from '@vercel/blob';

const STORE_PATH = 'admin/user-permissions.json';
let __CACHE__ = null;
let __CACHE_AT__ = 0;
const CACHE_TTL_MS = 30 * 1000; /* korte cache zodat mutations snel zichtbaar zijn */

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Blob read mislukt: ${response.status}`);
  return response.text();
}

export async function getAllUserPermissions({ refresh = false } = {}) {
  if (!refresh && __CACHE__ && (Date.now() - __CACHE_AT__) < CACHE_TTL_MS) {
    return __CACHE__;
  }

  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = result.blobs.find((b) => b.pathname === STORE_PATH);

    if (!blob) {
      __CACHE__ = {};
      __CACHE_AT__ = Date.now();
      return __CACHE__;
    }

    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '{}');
    __CACHE__ = (parsed && typeof parsed === 'object') ? parsed : {};
    __CACHE_AT__ = Date.now();
    return __CACHE__;
  } catch (error) {
    console.error('[user-permissions-store] read error:', error);
    return __CACHE__ || {};
  }
}

export async function getUserPermissions(personnelId) {
  if (!personnelId) return null;
  const all = await getAllUserPermissions();
  return all[String(personnelId)] || null;
}

async function writeAll(data) {
  await put(STORE_PATH, JSON.stringify(data, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  __CACHE__ = data;
  __CACHE_AT__ = Date.now();
}

export async function upsertUserPermissions(personnelId, patch = {}, updatedBy = 'admin') {
  if (!personnelId) throw new Error('personnelId is verplicht');

  const all = await getAllUserPermissions({ refresh: true });
  const id = String(personnelId);
  const existing = all[id] || {};

  const updated = {
    personnelId: id,
    role: patch.role || existing.role || 'medewerker',
    department: patch.department ?? existing.department ?? '',
    region: patch.region ?? existing.region ?? '',
    extraPermissions: Array.isArray(patch.extraPermissions)
      ? [...new Set(patch.extraPermissions.filter(Boolean))]
      : (existing.extraPermissions || []),
    revokedPermissions: Array.isArray(patch.revokedPermissions)
      ? [...new Set(patch.revokedPermissions.filter(Boolean))]
      : (existing.revokedPermissions || []),
    /* allowedStoresOverride: extra winkels die deze gebruiker mag inzien/bedienen
       bovenop de winkel(s) die SRS koppelt via personnelGroupId. Dit is een
       additieve lijst — SRS blijft autoritatief voor primaire koppeling.
       Voor office-users (geen SRS-record) is dit de volledige toegestane lijst. */
    allowedStoresOverride: Array.isArray(patch.allowedStoresOverride)
      ? [...new Set(patch.allowedStoresOverride.map((s) => String(s || '').trim()).filter(Boolean))]
      : (existing.allowedStoresOverride || []),
    notes: patch.notes ?? existing.notes ?? '',
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || existing.updatedBy || 'admin'),
    /* metadata caches (handig voor UI): laat de schrijver het laatst bekende
       SRS-naam veld zetten zodat we niet bij elke read SRS hoeven aan te roepen */
    snapshot: patch.snapshot || existing.snapshot || null
  };

  all[id] = updated;
  await writeAll(all);
  return updated;
}

export async function deleteUserPermissions(personnelId) {
  if (!personnelId) return false;
  const all = await getAllUserPermissions({ refresh: true });
  const id = String(personnelId);
  if (!(id in all)) return false;
  delete all[id];
  await writeAll(all);
  return true;
}

export async function bulkUpsert(items = [], updatedBy = 'admin') {
  if (!Array.isArray(items) || !items.length) return 0;
  const all = await getAllUserPermissions({ refresh: true });
  let count = 0;

  for (const item of items) {
    if (!item || !item.personnelId) continue;
    const id = String(item.personnelId);
    const existing = all[id] || {};
    all[id] = {
      personnelId: id,
      role: item.role || existing.role || 'medewerker',
      department: item.department ?? existing.department ?? '',
      region: item.region ?? existing.region ?? '',
      extraPermissions: Array.isArray(item.extraPermissions) ? [...new Set(item.extraPermissions.filter(Boolean))] : (existing.extraPermissions || []),
      revokedPermissions: Array.isArray(item.revokedPermissions) ? [...new Set(item.revokedPermissions.filter(Boolean))] : (existing.revokedPermissions || []),
      allowedStoresOverride: Array.isArray(item.allowedStoresOverride)
        ? [...new Set(item.allowedStoresOverride.map((s) => String(s || '').trim()).filter(Boolean))]
        : (existing.allowedStoresOverride || []),
      notes: item.notes ?? existing.notes ?? '',
      updatedAt: new Date().toISOString(),
      updatedBy: String(updatedBy || existing.updatedBy || 'admin'),
      snapshot: item.snapshot || existing.snapshot || null
    };
    count++;
  }

  await writeAll(all);
  return count;
}
