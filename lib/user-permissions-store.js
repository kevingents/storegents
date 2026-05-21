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

  /* Normaliseer afdelingen-array (multi). Backward-compat: als alleen 'afdeling'
     (single) is meegegeven, vouw die in de array. Bij read geven we beide terug
     zodat oude UI nog werkt. */
  const incomingAfdelingen = Array.isArray(patch.afdelingen)
    ? patch.afdelingen.map((a) => String(a || '').trim()).filter(Boolean)
    : (patch.afdeling != null
        ? [String(patch.afdeling).trim()].filter(Boolean)
        : null);
  const mergedAfdelingen = incomingAfdelingen != null
    ? [...new Set(incomingAfdelingen)]
    : (Array.isArray(existing.afdelingen)
        ? existing.afdelingen
        : (existing.afdeling ? [existing.afdeling] : []));

  const updated = {
    personnelId: id,
    role: patch.role || existing.role || 'medewerker',
    department: patch.department ?? existing.department ?? '',
    /* afdelingen: multi-array van virtuele winkels (Admin, Supplychain, Finance,
       Students, Suitconcer, ...). Iemand kan tot meerdere afdelingen behoren.
       afdeling (single) blijft als 'default'/eerste voor backward-compat met
       oude UI en als hint waar login default land. */
    afdelingen: mergedAfdelingen,
    afdeling: mergedAfdelingen[0] || '',
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
    /* groups: namen van groepen waar deze user lid van is — gebruikt voor
       gerichte mail-campaigns, escalaties en team-acties. */
    groups: Array.isArray(patch.groups)
      ? [...new Set(patch.groups.map((g) => String(g || '').trim()).filter(Boolean))]
      : (existing.groups || []),
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
    const incomingAfds = Array.isArray(item.afdelingen)
      ? item.afdelingen.map((a) => String(a || '').trim()).filter(Boolean)
      : (item.afdeling != null
          ? [String(item.afdeling).trim()].filter(Boolean)
          : null);
    const mergedAfds = incomingAfds != null
      ? [...new Set(incomingAfds)]
      : (Array.isArray(existing.afdelingen)
          ? existing.afdelingen
          : (existing.afdeling ? [existing.afdeling] : []));
    all[id] = {
      personnelId: id,
      role: item.role || existing.role || 'medewerker',
      department: item.department ?? existing.department ?? '',
      afdelingen: mergedAfds,
      afdeling: mergedAfds[0] || '',
      region: item.region ?? existing.region ?? '',
      extraPermissions: Array.isArray(item.extraPermissions) ? [...new Set(item.extraPermissions.filter(Boolean))] : (existing.extraPermissions || []),
      revokedPermissions: Array.isArray(item.revokedPermissions) ? [...new Set(item.revokedPermissions.filter(Boolean))] : (existing.revokedPermissions || []),
      allowedStoresOverride: Array.isArray(item.allowedStoresOverride)
        ? [...new Set(item.allowedStoresOverride.map((s) => String(s || '').trim()).filter(Boolean))]
        : (existing.allowedStoresOverride || []),
      groups: Array.isArray(item.groups)
        ? [...new Set(item.groups.map((g) => String(g || '').trim()).filter(Boolean))]
        : (existing.groups || []),
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
