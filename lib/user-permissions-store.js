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
 *
 * Opslag via json-blob-store: VERSE (cache-busted) reads + optimistische
 * read-modify-write. Dit verving een eigen in-memory cache (30s) + plain
 * put/list: die cache leefde per serverless-instance, dus een role-wijziging
 * was in een andere instance tot 30-60s niet zichtbaar ("ik gaf rechten maar
 * hij ziet niks"), en twee snelle edits overschreven elkaar (lost update).
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'admin/user-permissions.json';

function asMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export async function getAllUserPermissions() {
  try {
    return asMap(await readJsonBlob(STORE_PATH, {}));
  } catch (error) {
    console.error('[user-permissions-store] read error:', error);
    return {};
  }
}

export async function getUserPermissions(personnelId) {
  if (!personnelId) return null;
  const all = await getAllUserPermissions();
  return all[String(personnelId)] || null;
}

/** Bouw één genormaliseerde entry uit (patch ⊕ bestaande). */
function buildEntry(id, patch, existing, updatedBy) {
  /* Normaliseer afdelingen-array (multi). Backward-compat: als alleen 'afdeling'
     (single) is meegegeven, vouw die in de array. */
  const incomingAfdelingen = Array.isArray(patch.afdelingen)
    ? patch.afdelingen.map((a) => String(a || '').trim()).filter(Boolean)
    : (patch.afdeling != null ? [String(patch.afdeling).trim()].filter(Boolean) : null);
  const mergedAfdelingen = incomingAfdelingen != null
    ? [...new Set(incomingAfdelingen)]
    : (Array.isArray(existing.afdelingen)
        ? existing.afdelingen
        : (existing.afdeling ? [existing.afdeling] : []));

  return {
    personnelId: id,
    role: patch.role || existing.role || 'medewerker',
    department: patch.department ?? existing.department ?? '',
    afdelingen: mergedAfdelingen,
    afdeling: mergedAfdelingen[0] || '',
    region: patch.region ?? existing.region ?? '',
    extraPermissions: Array.isArray(patch.extraPermissions)
      ? [...new Set(patch.extraPermissions.filter(Boolean))]
      : (existing.extraPermissions || []),
    revokedPermissions: Array.isArray(patch.revokedPermissions)
      ? [...new Set(patch.revokedPermissions.filter(Boolean))]
      : (existing.revokedPermissions || []),
    /* allowedStoresOverride: extra winkels bovenop de SRS-koppeling (additief).
       Voor office-users (geen SRS-record) is dit de volledige toegestane lijst. */
    allowedStoresOverride: Array.isArray(patch.allowedStoresOverride)
      ? [...new Set(patch.allowedStoresOverride.map((s) => String(s || '').trim()).filter(Boolean))]
      : (existing.allowedStoresOverride || []),
    /* groups: namen van groepen voor mail-campaigns, escalaties en team-acties. */
    groups: Array.isArray(patch.groups)
      ? [...new Set(patch.groups.map((g) => String(g || '').trim()).filter(Boolean))]
      : (existing.groups || []),
    notes: patch.notes ?? existing.notes ?? '',
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || existing.updatedBy || 'admin'),
    /* snapshot: laatst bekende SRS-naam zodat we niet bij elke read SRS hoeven
       aan te roepen. */
    snapshot: patch.snapshot || existing.snapshot || null
  };
}

export async function upsertUserPermissions(personnelId, patch = {}, updatedBy = 'admin') {
  if (!personnelId) throw new Error('personnelId is verplicht');
  const id = String(personnelId);
  let result = null;
  await mutateJsonBlob(
    STORE_PATH,
    (current) => {
      const all = asMap(current);
      result = buildEntry(id, patch, all[id] || {}, updatedBy);
      all[id] = result;
      return all;
    },
    { fallback: {} }
  );
  return result;
}

export async function deleteUserPermissions(personnelId) {
  if (!personnelId) return false;
  const id = String(personnelId);
  let removed = false;
  await mutateJsonBlob(
    STORE_PATH,
    (current) => {
      const all = asMap(current);
      if (id in all) {
        delete all[id];
        removed = true;
      }
      return all;
    },
    { fallback: {} }
  );
  return removed;
}

export async function bulkUpsert(items = [], updatedBy = 'admin') {
  if (!Array.isArray(items) || !items.length) return 0;
  let count = 0;
  await mutateJsonBlob(
    STORE_PATH,
    (current) => {
      const all = asMap(current);
      count = 0;
      for (const item of items) {
        if (!item || !item.personnelId) continue;
        const id = String(item.personnelId);
        all[id] = buildEntry(id, item, all[id] || {}, updatedBy);
        count++;
      }
      return all;
    },
    { fallback: {} }
  );
  return count;
}
