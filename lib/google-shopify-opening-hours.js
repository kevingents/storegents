import { safeJson, listBranches } from './branch-metrics.js';

const GOOGLE_PLACES_NEW_BASE_URL = 'https://places.googleapis.com/v1';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_ADMIN_API_VERSION || '2025-01';
const STORE_METAOBJECT_TYPE = process.env.SHOPIFY_STORE_LOCATION_METAOBJECT_TYPE || 'store_locations';

const GOOGLE_OPENING_HOURS_FIELD_MASK = [
  'id',
  'name',
  'displayName',
  'formattedAddress',
  'googleMapsUri',
  'regularOpeningHours',
  'currentOpeningHours'
].join(',');

const DAY_NAMES = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

function clean(value) { return String(value || '').trim(); }
function normalizeKey(value) { return clean(value).toLowerCase().replace(/\s+/g, ' '); }

function readGoogleApiKey() {
  return clean(process.env.GOOGLE_API_VERCEL_KEY || process.env.GOOGLE_REVIEWS_API_KEY_BACKEND || process.env.GOOGLE_REVIEWS_API_KEY || process.env.GOOGLE_API_KEY);
}

function getGooglePlaceIdMap() { return safeJson(process.env.GOOGLE_PLACE_IDS_JSON, {}); }

function slugFromStore(store) {
  return normalizeKey(store).replace(/^gents\s+/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function fallbackLocationsFromPlaceIdMap() {
  const map = getGooglePlaceIdMap();
  return listBranches().map((branch) => ({
    ...branch,
    storeId: branch.branchId,
    slug: slugFromStore(branch.store),
    placeId: map[branch.branchId] || map[branch.store] || map[normalizeKey(branch.store)] || ''
  })).filter((location) => location.placeId);
}

export function getConfiguredGoogleStoreLocations() {
  const value = safeJson(process.env.GOOGLE_STORE_LOCATIONS_JSON, []);
  const configured = Array.isArray(value) ? value : [];
  return configured.length ? configured : fallbackLocationsFromPlaceIdMap();
}

function normalizePlaceId(value) {
  if (!value) return '';
  const raw = typeof value === 'object'
    ? clean(value.placeId || value.place_id || value.id || value.name || value.resourceName || value.placeResourceName)
    : clean(value);
  return raw.replace(/^places\//, '');
}

function resolveMappedPlaceId(location = {}) {
  const map = getGooglePlaceIdMap();
  const keys = [clean(location.branchId), clean(location.storeId), clean(location.store_id), clean(location.googleLocationCode), clean(location.store), normalizeKey(location.store), clean(location.slug)].filter(Boolean);
  for (const key of keys) {
    const placeId = normalizePlaceId(map[key]);
    if (placeId) return placeId;
  }
  return '';
}

function resolveLocationPlaceId(location = {}) {
  return normalizePlaceId(location.placeId || location.place_id || location.googlePlaceId || location.google_place_id) || resolveMappedPlaceId(location);
}

function resolveShopifyDomain() {
  const domain = clean(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_DOMAIN || process.env.SHOPIFY_STORE).replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (!domain) throw new Error('SHOPIFY_STORE_DOMAIN ontbreekt in Vercel.');
  return domain.includes('.myshopify.com') ? domain : `${domain}.myshopify.com`;
}

function resolveShopifyToken() {
  const token = clean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_API_TOKEN);
  if (!token) throw new Error('SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel.');
  return token;
}

async function fetchGoogleJson(url, { timeoutMs = 15000, fieldMask } = {}) {
  const apiKey = readGoogleApiKey();
  if (!apiKey) throw new Error('GOOGLE_API_VERCEL_KEY of GOOGLE_API_KEY ontbreekt in Vercel.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.message || data?.error?.status || `Google HTTP ${response.status}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function shopifyGraphql(query, variables = {}, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`https://${resolveShopifyDomain()}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': resolveShopifyToken() },
      body: JSON.stringify({ query, variables })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.errors) throw new Error(payload.errors?.[0]?.message || `Shopify HTTP ${response.status}`);
    return payload.data;
  } finally { clearTimeout(timer); }
}

function padTime(value) { return String(Number(value || 0)).padStart(2, '0'); }
function pointTime(point = {}) { return `${padTime(point.hour)}:${padTime(point.minute)}`; }
function pointDate(point = {}) {
  if (point.date?.year && point.date?.month && point.date?.day) return `${point.date.year}-${padTime(point.date.month)}-${padTime(point.date.day)}`;
  return clean(point.date);
}
function periodToRange(period = {}) {
  if (!period.open) return '';
  if (!period.close) return '00:00-23:59';
  return `${pointTime(period.open)}-${pointTime(period.close)}`;
}
function periodsToDayMap(periods = []) {
  const map = Object.fromEntries(DAY_NAMES.map((day) => [day, 'gesloten']));
  const ranges = new Map();
  for (const period of periods || []) {
    const dayIndex = Number(period.open?.day);
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) continue;
    const range = periodToRange(period);
    if (!range) continue;
    const dayName = DAY_NAMES[dayIndex];
    const list = ranges.get(dayName) || [];
    list.push(range);
    ranges.set(dayName, list);
  }
  for (const [dayName, list] of ranges.entries()) map[dayName] = list.join(', ');
  return map;
}
function specialHoursFromCurrentPeriods(currentOpeningHours = {}, regularHoursJson = {}) {
  const byDate = new Map();
  for (const period of currentOpeningHours.periods || []) {
    const date = pointDate(period.open || {});
    if (!date) continue;
    const range = periodToRange(period);
    if (!range) continue;
    const list = byDate.get(date) || [];
    list.push(range);
    byDate.set(date, list);
  }
  const special = {};
  for (const [date, list] of byDate.entries()) {
    const jsDay = new Date(`${date}T12:00:00Z`).getUTCDay();
    const regular = regularHoursJson[DAY_NAMES[jsDay]] || 'gesloten';
    const current = list.join(', ');
    if (current !== regular) special[date] = current;
  }
  return special;
}
function todayTextFromHours(currentOpeningHours = {}, regularHoursJson = {}) {
  const descriptions = currentOpeningHours.weekdayDescriptions || currentOpeningHours.weekday_descriptions || [];
  if (descriptions.length) {
    const today = DAY_NAMES[new Date().getDay()];
    const found = descriptions.find((line) => normalizeKey(line).startsWith(today));
    if (found) return found;
  }
  const dayName = DAY_NAMES[new Date().getDay()];
  const value = regularHoursJson[dayName] || 'gesloten';
  return value === 'gesloten' ? 'Vandaag gesloten' : `Vandaag ${value}`;
}
function fieldValue(fields = [], key) { return fields.find((field) => field.key === key)?.value || ''; }
function locationCandidates(location = {}) {
  return [clean(location.shopifyMetaobjectId), clean(location.metaobjectId), clean(location.shopifyHandle), clean(location.handle), clean(location.slug), clean(location.store_id), clean(location.storeId), clean(location.branchId), clean(location.store), normalizeKey(location.store)].filter(Boolean);
}
async function findShopifyStoreLocationMetaobject(location = {}) {
  const explicitId = clean(location.shopifyMetaobjectId || location.metaobjectId);
  if (explicitId.startsWith('gid://shopify/Metaobject/')) return { id: explicitId, match: 'explicit-id' };
  const query = `#graphql
    query StoreLocations($type: String!, $first: Int!) {
      metaobjects(type: $type, first: $first) {
        nodes { id handle fields { key value } }
      }
    }
  `;
  const data = await shopifyGraphql(query, { type: STORE_METAOBJECT_TYPE, first: Number(process.env.SHOPIFY_STORE_LOCATION_SEARCH_LIMIT || 100) });
  const nodes = data?.metaobjects?.nodes || [];
  const candidates = new Set(locationCandidates(location).map(normalizeKey));
  const found = nodes.find((node) => {
    const values = [node.id, node.handle, fieldValue(node.fields, 'slug'), fieldValue(node.fields, 'store_id'), fieldValue(node.fields, 'title'), fieldValue(node.fields, 'city'), fieldValue(node.fields, 'name')];
    return values.some((value) => candidates.has(normalizeKey(value)));
  });
  if (!found) throw new Error(`Geen Shopify metaobject gevonden voor ${location.store || location.slug || location.branchId || 'winkel'}.`);
  return { id: found.id, handle: found.handle, match: 'search' };
}
async function updateShopifyStoreLocationFields(metaobjectId, fields) {
  const mutation = `#graphql
    mutation UpdateStoreLocation($id: ID!, $metaobject: MetaobjectUpdateInput!) {
      metaobjectUpdate(id: $id, metaobject: $metaobject) {
        metaobject { id handle }
        userErrors { field message code }
      }
    }
  `;
  const data = await shopifyGraphql(mutation, { id: metaobjectId, metaobject: { fields } });
  const errors = data?.metaobjectUpdate?.userErrors || [];
  if (errors.length) throw new Error(errors.map((error) => error.message).join('; '));
  return data?.metaobjectUpdate?.metaobject;
}
export async function getGoogleOpeningHoursForLocation(location = {}, { language = 'nl', timeoutMs = 15000 } = {}) {
  const placeId = resolveLocationPlaceId(location);
  if (!placeId) throw new Error(`Geen Google place_id ingesteld voor ${location.store || location.branchId || 'winkel'}.`);
  const data = await fetchGoogleJson(`${GOOGLE_PLACES_NEW_BASE_URL}/places/${encodeURIComponent(placeId)}?languageCode=${encodeURIComponent(language)}`, { timeoutMs, fieldMask: GOOGLE_OPENING_HOURS_FIELD_MASK });
  const regularHoursJson = periodsToDayMap(data.regularOpeningHours?.periods || []);
  const specialHoursJson = specialHoursFromCurrentPeriods(data.currentOpeningHours || {}, regularHoursJson);
  const todayText = todayTextFromHours(data.currentOpeningHours || {}, regularHoursJson);
  return { placeId, placeResourceName: data.name || '', name: data.displayName?.text || location.store || '', address: data.formattedAddress || location.address || '', googleMapsUrl: data.googleMapsUri || '', hoursJson: regularHoursJson, specialHoursJson, todayText, raw: { regularOpeningHours: data.regularOpeningHours || null, currentOpeningHours: data.currentOpeningHours || null } };
}
export async function syncGoogleOpeningHoursToShopify(location = {}, options = {}) {
  const hours = await getGoogleOpeningHoursForLocation(location, options);
  const target = await findShopifyStoreLocationMetaobject(location);
  const fields = [
    { key: process.env.SHOPIFY_HOURS_FIELD_KEY || 'hours_json', value: JSON.stringify(hours.hoursJson, null, 2) },
    { key: process.env.SHOPIFY_TODAY_TEXT_FIELD_KEY || 'today_text', value: hours.todayText },
    { key: process.env.SHOPIFY_SPECIAL_HOURS_FIELD_KEY || 'special_hours_json', value: JSON.stringify(hours.specialHoursJson, null, 2) }
  ];
  const updated = options.dryRun ? null : await updateShopifyStoreLocationFields(target.id, fields);
  return { success: true, dryRun: Boolean(options.dryRun), store: location.store || hours.name, branchId: clean(location.branchId || location.storeId || location.store_id), slug: clean(location.slug), metaobjectId: target.id, metaobjectHandle: target.handle || updated?.handle || '', match: target.match, fields, hoursJson: hours.hoursJson, specialHoursJson: hours.specialHoursJson, todayText: hours.todayText, google: { placeId: hours.placeId, name: hours.name, address: hours.address, googleMapsUrl: hours.googleMapsUrl } };
}
