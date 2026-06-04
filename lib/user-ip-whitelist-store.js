/**
 * lib/user-ip-whitelist-store.js
 *
 * Per-gebruiker IP-whitelist voor thuiswerk-toegang. Personeel met een
 * thuiskantoor-IP in zijn whitelist hoeft NIET via SRS-personeel-pin in te
 * loggen vanaf dat IP — zelfde toegang als vanaf de winkel-PC.
 *
 * Blob shape (admin/user-ip-whitelist.json):
 *   {
 *     "1011": {
 *       personnelId: "1011",
 *       label: "Jorik Douma",
 *       entries: [
 *         { ip: "84.x.x.x", label: "Thuis", addedAt: "2026-06-04T...", addedBy: "admin" },
 *         { ip: "2001:...", label: "Thuis IPv6", addedAt: "...", addedBy: "admin" }
 *       ],
 *       defaultStore: "GENTS Delft",  // welke winkel-context bij IP-match
 *       updatedAt: "..."
 *     }
 *   }
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'admin/user-ip-whitelist.json';

const clean = (v) => String(v == null ? '' : v).trim();
const normalizeIp = (ip) => clean(ip).toLowerCase();

export async function readAllWhitelists() {
  const data = await readJsonBlob(PATH, {}).catch(() => ({}));
  return data && typeof data === 'object' ? data : {};
}

export async function readWhitelistForPersonnel(personnelId) {
  const all = await readAllWhitelists();
  return all[String(personnelId)] || null;
}

/** Find: gegeven een IP, return alle gebruikers wiens whitelist het IP bevat. */
export async function findPersonnelByIp(ip) {
  const target = normalizeIp(ip);
  if (!target) return [];
  const all = await readAllWhitelists();
  const matches = [];
  for (const [pid, rec] of Object.entries(all)) {
    const entries = Array.isArray(rec?.entries) ? rec.entries : [];
    if (entries.some((e) => normalizeIp(e.ip) === target)) {
      matches.push({ personnelId: pid, label: rec.label || '', defaultStore: rec.defaultStore || '' });
    }
  }
  return matches;
}

/** Upsert: voeg/update whitelist-entry voor een personnelId. */
export async function setWhitelistEntries(personnelId, { entries = [], label = '', defaultStore = '' }, actor = 'admin') {
  const pid = clean(personnelId);
  if (!pid) throw new Error('personnelId is verplicht.');
  const safe = (entries || [])
    .map((e) => ({
      ip: normalizeIp(e.ip),
      label: clean(e.label),
      addedAt: e.addedAt || new Date().toISOString(),
      addedBy: e.addedBy || actor
    }))
    .filter((e) => e.ip);
  await mutateJsonBlob(PATH, (cur) => {
    const all = cur && typeof cur === 'object' ? { ...cur } : {};
    all[pid] = {
      personnelId: pid,
      label: clean(label),
      defaultStore: clean(defaultStore),
      entries: safe,
      updatedAt: new Date().toISOString(),
      updatedBy: actor
    };
    return all;
  }, { fallback: {} });
  return { personnelId: pid, entries: safe };
}

/** Verwijder hele whitelist voor een personnelId. */
export async function removeWhitelist(personnelId) {
  const pid = clean(personnelId);
  await mutateJsonBlob(PATH, (cur) => {
    const all = cur && typeof cur === 'object' ? { ...cur } : {};
    delete all[pid];
    return all;
  }, { fallback: {} });
  return { personnelId: pid, removed: true };
}
