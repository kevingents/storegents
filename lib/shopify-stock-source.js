/**
 * lib/shopify-stock-source.js
 *
 * SINGLE SOURCE OF TRUTH voor voorraad. Iedere flow die wil weten "hoeveel
 * staat er op voorraad" hoort hier doorheen — niet meer direct SRS-snapshot,
 * niet meer voorraad-blobs.
 *
 * Mapping branchId → Shopify locationId loopt via shopify-locations.js
 * (matched op Shopify-location-naam = onze winkel-naam, bv "GENTS Amsterdam").
 *
 * Cache: 60s in-memory per Vercel-instance — vers genoeg voor real-time
 * winkel-tools, niet zo agressief dat Shopify-rate-limits raken bij
 * gelijktijdige requests.
 *
 * Voornaamste API:
 *   getStockByBarcode(barcode, { branchId, locationId })
 *   getStockBySku(sku, { branchId, locationId })
 *   getStockMapByBarcodes(barcodes[], { branchId, locationId })
 *   getStockPerLocation(barcode)              → { locationName: aantal }
 *   getTotalStock(barcode)                    → som over alle locations
 */

import { getLocationIdByName, getLocationsMap } from './shopify-locations.js';
import { branchIdToStoreName } from './business-config.js';

const clean = (v) => String(v == null ? '' : v).trim();

/* In-memory cache: 60s. Key = `${barcode|sku}::${locationId|all}`. */
const CACHE_TTL_MS = 60 * 1000;
const __cache = new Map();
let __inflight = new Map();

function cacheKey(query, locationId) {
  return `${query}::${locationId || 'all'}`;
}

function readCache(key) {
  const entry = __cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    __cache.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  __cache.set(key, { at: Date.now(), value });
}

export function clearStockCache() {
  __cache.clear();
  __inflight.clear();
}

/* ─── Shopify GraphQL helpers ──────────────────────────────────────────── */

function shopifyConfig() {
  const shop = clean(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = clean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '');
  const version = clean(process.env.SHOPIFY_API_VERSION || '2025-01');
  if (!shop || !token) throw new Error('Shopify ontbreekt (SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_ACCESS_TOKEN).');
  return { shop, token, version };
}

async function shopifyGraphql(query, variables = {}, { timeoutMs = 20000 } = {}) {
  const cfg = shopifyConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': cfg.token },
      body: JSON.stringify({ query, variables })
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Shopify GraphQL ${resp.status}: ${JSON.stringify(json).slice(0, 200)}`);
    if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
    return json.data;
  } finally { clearTimeout(timer); }
}

/* ─── Branch → locationId resolver ─────────────────────────────────────── */

/**
 * Vertaal een SRS branchId (bv. '15') naar een Shopify locationId.
 * Cached via shopify-locations TTL. Returnt null als geen mapping mogelijk.
 *
 * Werkt door: branchId → branchIdToStoreName → 'GENTS Amsterdam' →
 *             getLocationIdByName → Shopify locationId.
 */
export async function resolveLocationIdForBranch(branchId) {
  const id = clean(branchId);
  if (!id) return null;
  const storeName = branchIdToStoreName(id);
  if (!storeName) return null;
  return await getLocationIdByName(storeName);
}

/* ─── Core: getStockByBarcode/Sku ──────────────────────────────────────── */

/**
 * Returnt het aantal beschikbare units voor een barcode (EAN/UPC) op 1 locatie
 * (of totaal als geen locationId/branchId gegeven). Cached 60s.
 *
 * @returns {Promise<number>} 0 als niet gevonden/niet beschikbaar.
 */
export async function getStockByBarcode(barcode, { branchId, locationId } = {}) {
  const bc = clean(barcode);
  if (!bc) return 0;

  let locId = clean(locationId);
  if (!locId && branchId) locId = await resolveLocationIdForBranch(branchId);

  const key = cacheKey(`bc:${bc}`, locId);
  const cached = readCache(key);
  if (cached != null) return cached;

  /* Dedupe in-flight requests (zelfde key tegelijk = 1 request). */
  if (__inflight.has(key)) return __inflight.get(key);
  const promise = (async () => {
    try {
      const q = `query StockByBarcode($q: String!) {
        productVariants(first: 5, query: $q) {
          nodes {
            id sku barcode title
            inventoryItem {
              inventoryLevels(first: 30) {
                nodes { available location { id name } }
              }
            }
          }
        }
      }`;
      const data = await shopifyGraphql(q, { q: `barcode:${bc}` });
      const variants = data?.productVariants?.nodes || [];
      if (!variants.length) return 0;
      let total = 0;
      for (const v of variants) {
        const levels = v.inventoryItem?.inventoryLevels?.nodes || [];
        for (const lvl of levels) {
          if (!locId || clean(lvl.location?.id).endsWith(`/${locId}`) || clean(lvl.location?.id) === locId) {
            total += Number(lvl.available || 0);
          }
        }
      }
      writeCache(key, total);
      return total;
    } catch (e) {
      console.warn(`[shopify-stock] getStockByBarcode(${bc}) faalde: ${e.message}`);
      return 0;
    } finally {
      __inflight.delete(key);
    }
  })();
  __inflight.set(key, promise);
  return promise;
}

export async function getStockBySku(sku, { branchId, locationId } = {}) {
  const s = clean(sku);
  if (!s) return 0;
  let locId = clean(locationId);
  if (!locId && branchId) locId = await resolveLocationIdForBranch(branchId);

  const key = cacheKey(`sku:${s}`, locId);
  const cached = readCache(key);
  if (cached != null) return cached;
  if (__inflight.has(key)) return __inflight.get(key);

  const promise = (async () => {
    try {
      const q = `query StockBySku($q: String!) {
        productVariants(first: 5, query: $q) {
          nodes {
            inventoryItem {
              inventoryLevels(first: 30) {
                nodes { available location { id } }
              }
            }
          }
        }
      }`;
      const data = await shopifyGraphql(q, { q: `sku:${s}` });
      const variants = data?.productVariants?.nodes || [];
      let total = 0;
      for (const v of variants) {
        for (const lvl of (v.inventoryItem?.inventoryLevels?.nodes || [])) {
          if (!locId || clean(lvl.location?.id).endsWith(`/${locId}`) || clean(lvl.location?.id) === locId) {
            total += Number(lvl.available || 0);
          }
        }
      }
      writeCache(key, total);
      return total;
    } catch (e) {
      console.warn(`[shopify-stock] getStockBySku(${s}) faalde: ${e.message}`);
      return 0;
    } finally {
      __inflight.delete(key);
    }
  })();
  __inflight.set(key, promise);
  return promise;
}

/* ─── Bulk: meerdere barcodes in 1 batch ───────────────────────────────── */

/**
 * Bulk-lookup voor meerdere barcodes tegelijk. Returnt Map<barcode, aantal>.
 * Gebruikt 'barcode:X OR barcode:Y OR ...' query, splitst in batches van 50
 * om Shopify-query-lengte te respecteren.
 */
export async function getStockMapByBarcodes(barcodes = [], { branchId, locationId } = {}) {
  const clean_bcs = [...new Set(barcodes.map(clean).filter(Boolean))];
  if (!clean_bcs.length) return new Map();

  let locId = clean(locationId);
  if (!locId && branchId) locId = await resolveLocationIdForBranch(branchId);

  const result = new Map();
  const CHUNK = 50;
  for (let i = 0; i < clean_bcs.length; i += CHUNK) {
    const chunk = clean_bcs.slice(i, i + CHUNK);
    const query = chunk.map((b) => `barcode:${b}`).join(' OR ');
    try {
      const q = `query StockBulk($q: String!) {
        productVariants(first: 250, query: $q) {
          nodes {
            sku barcode
            inventoryItem {
              inventoryLevels(first: 30) {
                nodes { available location { id } }
              }
            }
          }
        }
      }`;
      const data = await shopifyGraphql(q, { q: query });
      const variants = data?.productVariants?.nodes || [];
      for (const v of variants) {
        const bc = clean(v.barcode);
        if (!bc) continue;
        let total = 0;
        for (const lvl of (v.inventoryItem?.inventoryLevels?.nodes || [])) {
          if (!locId || clean(lvl.location?.id).endsWith(`/${locId}`) || clean(lvl.location?.id) === locId) {
            total += Number(lvl.available || 0);
          }
        }
        /* Bij dubbele variants (zelfde barcode op meerdere products) sommeren. */
        result.set(bc, (result.get(bc) || 0) + total);
      }
    } catch (e) {
      console.warn(`[shopify-stock] getStockMapByBarcodes batch faalde: ${e.message}`);
    }
  }
  /* Vul ontbrekende EANs met 0 zodat caller weet dat ze gechecked zijn. */
  for (const bc of clean_bcs) if (!result.has(bc)) result.set(bc, 0);
  return result;
}

/* ─── Per-location breakdown ───────────────────────────────────────────── */

/**
 * Returnt { locationName: aantal, ... } voor 1 barcode.
 * Handig voor voorraad-zoek UI die per winkel toont.
 */
export async function getStockPerLocation(barcode) {
  const bc = clean(barcode);
  if (!bc) return {};
  const key = cacheKey(`bcLoc:${bc}`, 'breakdown');
  const cached = readCache(key);
  if (cached != null) return cached;
  if (__inflight.has(key)) return __inflight.get(key);
  const promise = (async () => {
    try {
      const [data, locMap] = await Promise.all([
        shopifyGraphql(`query($q: String!) {
          productVariants(first: 5, query: $q) {
            nodes {
              inventoryItem {
                inventoryLevels(first: 30) {
                  nodes { available location { id name } }
                }
              }
            }
          }
        }`, { q: `barcode:${bc}` }),
        getLocationsMap()
      ]);
      const result = {};
      const variants = data?.productVariants?.nodes || [];
      for (const v of variants) {
        for (const lvl of (v.inventoryItem?.inventoryLevels?.nodes || [])) {
          const name = clean(lvl.location?.name) || 'Onbekend';
          result[name] = (result[name] || 0) + Number(lvl.available || 0);
        }
      }
      writeCache(key, result);
      void locMap;
      return result;
    } catch (e) {
      console.warn(`[shopify-stock] getStockPerLocation(${bc}) faalde: ${e.message}`);
      return {};
    } finally {
      __inflight.delete(key);
    }
  })();
  __inflight.set(key, promise);
  return promise;
}

export async function getTotalStock(barcode) {
  return getStockByBarcode(barcode);
}

/**
 * Bulk-lookup voor meerdere barcodes gesommeerd over een SET locations.
 * Bedoeld voor bol-stock-sync: som over alle magazijn-locationIds.
 *
 * @param {string[]} barcodes
 * @param {string[]} locationIds  Shopify location numeric IDs of GIDs
 * @returns {Promise<Map<string, number>>}
 */
export async function getStockMapForLocations(barcodes = [], locationIds = []) {
  const bcs = [...new Set(barcodes.map(clean).filter(Boolean))];
  if (!bcs.length) return new Map();
  const locSet = new Set(locationIds.map(clean).filter(Boolean));
  /* Vergelijk zowel numeric id als de GID-vorm (gid://shopify/Location/{id}). */
  const matchesLoc = (lvlLocationId) => {
    if (!locSet.size) return true;
    const id = clean(lvlLocationId);
    if (locSet.has(id)) return true;
    /* GID format: gid://shopify/Location/12345 → match 12345 */
    const numeric = id.split('/').pop();
    return locSet.has(numeric);
  };

  const result = new Map();
  const CHUNK = 50;
  for (let i = 0; i < bcs.length; i += CHUNK) {
    const chunk = bcs.slice(i, i + CHUNK);
    const query = chunk.map((b) => `barcode:${b}`).join(' OR ');
    try {
      const q = `query StockMultiLoc($q: String!) {
        productVariants(first: 250, query: $q) {
          nodes {
            sku barcode
            inventoryItem {
              inventoryLevels(first: 30) {
                nodes { available location { id } }
              }
            }
          }
        }
      }`;
      const data = await shopifyGraphql(q, { q: query });
      const variants = data?.productVariants?.nodes || [];
      for (const v of variants) {
        const bc = clean(v.barcode);
        if (!bc) continue;
        let total = 0;
        for (const lvl of (v.inventoryItem?.inventoryLevels?.nodes || [])) {
          if (matchesLoc(lvl.location?.id)) {
            total += Number(lvl.available || 0);
          }
        }
        result.set(bc, (result.get(bc) || 0) + total);
      }
    } catch (e) {
      console.warn(`[shopify-stock] getStockMapForLocations batch faalde: ${e.message}`);
    }
  }
  for (const bc of bcs) if (!result.has(bc)) result.set(bc, 0);
  return result;
}
