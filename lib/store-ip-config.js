/**
 * lib/store-ip-config.js
 *
 * IP-mapping per winkel (IPv4 + IPv6). Gebruikt door access-check om automatisch
 * te bepalen vanuit welke winkel een request binnenkomt — zodat winkelmedewerkers
 * niet handmatig hoeven inloggen wanneer ze vanaf de winkel-PC werken.
 *
 * Data-laag:
 *   - DEFAULT_STORE_IPS: hardcoded baseline uit user-config (juni 2026)
 *   - blob admin/store-ip-overrides.json: admin-overrides per winkel (toevoegen
 *     extra IPs zonder deploy)
 *
 * Lookup is O(1) via een omgekeerde index ip → store.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const OVERRIDE_PATH = 'admin/store-ip-overrides.json';
const CACHE_TTL_MS = 5 * 60 * 1000;

/* Defaults uit user-lijst — IPv4 + IPv6 per winkel. Lege winkels (06/07/09/11/21/24/25)
   weggelaten zodat alleen actieve locaties matchen. */
const DEFAULT_STORE_IPS = {
  'GENTS Almere':        { branchId: '1',  ipv4: ['143.177.245.69'],  ipv6: ['2001:4860:7:21f::fc'] },
  'GENTS Amersfoort':    { branchId: '2',  ipv4: ['85.146.20.72'],    ipv6: ['2001:4860:7:161f::f5'] },
  'GENTS Arnhem':        { branchId: '3',  ipv4: ['87.208.205.228'],  ipv6: ['2001:4860:7:161f::f2'] },
  'GENTS Breda':         { branchId: '4',  ipv4: ['86.94.20.123'],    ipv6: ['2001:4860:7:141f::fd'] },
  'GENTS Delft':         { branchId: '5',  ipv4: ['188.91.34.138'],   ipv6: ['2001:4860:7:61f::f4'] },
  'GENTS Enschede':      { branchId: '8',  ipv4: ['80.61.136.129'],   ipv6: ['2001:4860:7:171f::f2'] },
  'GENTS Groningen':     { branchId: '10', ipv4: ['82.169.133.17'],   ipv6: ['2001:4860:7:21f::fb'] },
  'GENTS Hilversum':     { branchId: '12', ipv4: ['85.144.236.101'],  ipv6: ['2001:4860:7:21f::fc'] },
  'GENTS Leiden':        { branchId: '13', ipv4: ['195.240.254.134'], ipv6: [] },
  'GENTS Maastricht':    { branchId: '14', ipv4: ['31.21.157.45'],    ipv6: ['2001:4860:7:141f::f6'] },
  'GENTS Amsterdam':     { branchId: '15', ipv4: ['81.206.247.245'],  ipv6: ['2a02:a452:db98:0:b5a7:ca73:16ba:ed'] },
  'GENTS Nijmegen':      { branchId: '16', ipv4: ['77.162.211.164'],  ipv6: ['2001:4860:7:141f::fd'] },
  'GENTS Tilburg':       { branchId: '17', ipv4: ['82.169.64.155'],   ipv6: [] },
  'GENTS Utrecht':       { branchId: '18', ipv4: ['81.207.94.55'],    ipv6: [] },
  'GENTS Zoetermeer':    { branchId: '19', ipv4: ['77.163.158.93'],   ipv6: ['2001:4860:7:21f::fc'] },
  'GENTS Rotterdam':     { branchId: '20', ipv4: ['86.80.119.195'],   ipv6: [] },
  'GENTS Zwolle':        { branchId: '22', ipv4: ['77.164.101.68'],   ipv6: ['2001:4860:7:141f::f3'] },
  'GENTS Den Bosch':     { branchId: '23', ipv4: ['86.94.131.21'],    ipv6: ['2001:4860:7:141f::f3'] },
  'GENTS Antwerpen':     { branchId: '50', ipv4: ['91.180.172.48'],   ipv6: ['2001:4860:7:1406::fa'] },
  'GENTS Showroom':      { branchId: '700', ipv4: ['45.132.43.73'],   ipv6: ['2001:4860:7:151f::f3'] }
};

let __cache = null;
let __cacheAt = 0;

/** Lees actuele config (defaults + admin-overrides). */
export async function getStoreIpConfig({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && __cache && (now - __cacheAt) < CACHE_TTL_MS) return __cache;
  const override = await readJsonBlob(OVERRIDE_PATH, {}).catch(() => ({}));
  /* Merge: override extra IPs naast defaults, niet vervangen. */
  const merged = {};
  for (const [store, def] of Object.entries(DEFAULT_STORE_IPS)) {
    const ov = override?.[store] || {};
    merged[store] = {
      branchId: def.branchId,
      ipv4: dedupe([...(def.ipv4 || []), ...((ov.ipv4 || []))]),
      ipv6: dedupe([...(def.ipv6 || []), ...((ov.ipv6 || []))])
    };
  }
  /* Toegevoegde winkels die alleen in override staan (toekomst-proof). */
  for (const [store, ov] of Object.entries(override || {})) {
    if (!merged[store] && ov && (ov.ipv4 || ov.ipv6)) {
      merged[store] = { branchId: ov.branchId || '', ipv4: ov.ipv4 || [], ipv6: ov.ipv6 || [] };
    }
  }
  /* Bouw omgekeerde index ip → store voor O(1) lookup. */
  const ipToStore = {};
  for (const [store, c] of Object.entries(merged)) {
    for (const ip of (c.ipv4 || [])) ipToStore[normalizeIp(ip)] = store;
    for (const ip of (c.ipv6 || [])) ipToStore[normalizeIp(ip)] = store;
  }
  __cache = { stores: merged, ipToStore, generatedAt: new Date().toISOString() };
  __cacheAt = now;
  return __cache;
}

/** Lookup: welke winkel hoort bij dit IP? Returnt store-name of null. */
export async function findStoreByIp(ip) {
  if (!ip) return null;
  const cfg = await getStoreIpConfig();
  return cfg.ipToStore[normalizeIp(ip)] || null;
}

/** Override-API voor admin (extra IPs toevoegen aan een winkel). */
export async function addStoreIpOverride(store, { ipv4 = [], ipv6 = [] } = {}) {
  const path = OVERRIDE_PATH;
  const current = await readJsonBlob(path, {}).catch(() => ({}));
  current[store] = current[store] || { ipv4: [], ipv6: [] };
  current[store].ipv4 = dedupe([...(current[store].ipv4 || []), ...(ipv4 || [])]);
  current[store].ipv6 = dedupe([...(current[store].ipv6 || []), ...(ipv6 || [])]);
  await writeJsonBlob(path, current);
  __cache = null; __cacheAt = 0;
  return current[store];
}

function normalizeIp(ip) {
  return String(ip || '').toLowerCase().trim();
}

function dedupe(arr) {
  return [...new Set((arr || []).map((s) => normalizeIp(s)).filter(Boolean))];
}
