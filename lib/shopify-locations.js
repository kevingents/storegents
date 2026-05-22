/**
 * Shopify Locations cache — vertaalt location_id → naam.
 *
 * Wordt 1x per uur opnieuw opgehaald. Locations veranderen zelden,
 * dus aggressievere cache is acceptabel.
 */

let CACHE = { ts: 0, byId: new Map() };
const TTL_MS = 60 * 60 * 1000;

function getConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

async function refreshLocations() {
  const cfg = getConfig();
  if (!cfg) return new Map();
  try {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/locations.json`, {
      headers: { 'X-Shopify-Access-Token': cfg.token, Accept: 'application/json' }
    });
    if (!resp.ok) return new Map();
    const data = await resp.json();
    const map = new Map();
    for (const loc of data.locations || []) {
      map.set(String(loc.id), {
        id: String(loc.id),
        name: String(loc.name || '').trim(),
        city: String(loc.city || '').trim(),
        country: String(loc.country_code || '').trim(),
        active: Boolean(loc.active)
      });
    }
    return map;
  } catch (error) {
    console.error('[shopify-locations] refresh error:', error.message);
    return new Map();
  }
}

export async function getLocationsMap() {
  if (CACHE.byId.size && (Date.now() - CACHE.ts) < TTL_MS) return CACHE.byId;
  CACHE = { ts: Date.now(), byId: await refreshLocations() };
  return CACHE.byId;
}

/**
 * Vertaal location_id naar een leesbare GENTS-winkel naam.
 * Probeert eerst de cached Shopify-locations, valt terug op generieke labels.
 */
export async function resolveLocationName(locationId) {
  if (!locationId) return null;
  const map = await getLocationsMap();
  const loc = map.get(String(locationId));
  if (!loc) return null;
  /* Shopify location-naam is meestal al de winkelnaam ('GENTS Amsterdam' etc.) */
  return loc.name || loc.city || null;
}

/**
 * Vertaal Shopify locatienaam (bijv. "GENTS Amersfoort") naar een location_id.
 * Case-insensitieve vergelijking; valt terug op null als niet gevonden.
 */
export async function getLocationIdByName(name) {
  if (!name) return null;
  const map = await getLocationsMap();
  const needle = String(name).trim().toLowerCase();
  for (const loc of map.values()) {
    if (String(loc.name || '').trim().toLowerCase() === needle) return loc.id;
  }
  return null;
}

export function clearLocationsCache() {
  CACHE = { ts: 0, byId: new Map() };
}
