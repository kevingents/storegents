import { safeJson } from './branch-metrics.js';

const GOOGLE_PLACES_NEW_BASE_URL = 'https://places.googleapis.com/v1';

const PLACE_DETAILS_FIELD_MASK = [
  'id',
  'name',
  'displayName',
  'formattedAddress',
  'businessStatus',
  'rating',
  'userRatingCount',
  'reviews',
  'googleMapsUri'
].join(',');

const TEXT_SEARCH_FIELD_MASK = [
  'places.id',
  'places.name',
  'places.displayName',
  'places.formattedAddress',
  'places.businessStatus',
  'places.rating',
  'places.userRatingCount',
  'places.googleMapsUri'
].join(',');

function readGoogleApiKey() {
  return String(process.env.GOOGLE_API_KEY || '').trim();
}

function getPlaceIdMap() {
  return safeJson(process.env.GOOGLE_PLACE_IDS_JSON, {});
}

function getStoreLocations() {
  const value = safeJson(process.env.GOOGLE_STORE_LOCATIONS_JSON, []);
  return Array.isArray(value) ? value : [];
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizePlaceId(value) {
  return String(value || '').trim().replace(/^places\//, '');
}

function resolveMappedPlaceId({ store, branchId, googleLocationCode }) {
  const map = getPlaceIdMap();
  const keys = [
    String(branchId || '').trim(),
    String(googleLocationCode || '').trim(),
    String(store || '').trim(),
    normalizeKey(store)
  ].filter(Boolean);

  for (const key of keys) {
    if (map[key]) return normalizePlaceId(map[key]);
  }

  return '';
}

export function findConfiguredGoogleStoreLocation({ store, branchId, googleLocationCode } = {}) {
  const storeKey = normalizeKey(store);
  const id = String(branchId || '').trim();
  const code = String(googleLocationCode || '').trim();

  return getStoreLocations().find((location) => {
    if (id && String(location.branchId || '').trim() === id) return true;
    if (code && String(location.googleLocationCode || '').trim() === code) return true;
    if (storeKey && normalizeKey(location.store) === storeKey) return true;
    return false;
  }) || null;
}

function buildLookupQuery({ store, branchId, googleLocationCode, query } = {}) {
  const explicitQuery = String(query || '').trim();
  if (explicitQuery) return explicitQuery;

  const location = findConfiguredGoogleStoreLocation({ store, branchId, googleLocationCode });
  if (location) {
    return [location.store, location.address].filter(Boolean).join(', ');
  }

  return String(store || '').trim();
}

function googleStatusMessage(error = {}) {
  const message = String(error.message || error.status || '').trim();
  if (message) return message;
  return 'Google Places API fout.';
}

async function fetchGoogleJson(url, { timeoutMs, method = 'GET', body, fieldMask } = {}) {
  const apiKey = readGoogleApiKey();
  if (!apiKey) throw new Error('GOOGLE_API_KEY ontbreekt in Vercel.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const headers = {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': apiKey
  };

  if (fieldMask) headers['X-Goog-FieldMask'] = fieldMask;

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(googleStatusMessage(data.error) || `Google HTTP ${response.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeReview(review = {}) {
  return {
    authorName: review.authorAttribution?.displayName || '',
    authorUrl: review.authorAttribution?.uri || '',
    profilePhotoUrl: review.authorAttribution?.photoUri || '',
    rating: Number(review.rating || 0),
    text: review.text?.text || review.originalText?.text || '',
    language: review.text?.languageCode || review.originalText?.languageCode || '',
    relativeTimeDescription: review.relativePublishTimeDescription || '',
    time: review.publishTime || null,
    date: review.publishTime || ''
  };
}

function normalizePlaceDetails(result = {}, source = 'place-details-new') {
  const reviews = Array.isArray(result.reviews) ? result.reviews.map(normalizeReview) : [];

  return {
    source,
    placeId: normalizePlaceId(result.id || result.name || ''),
    placeResourceName: result.name || '',
    name: result.displayName?.text || '',
    address: result.formattedAddress || '',
    businessStatus: result.businessStatus || '',
    rating: Number(result.rating || 0),
    reviewCount: Number(result.userRatingCount || 0),
    userRatingsTotal: Number(result.userRatingCount || 0),
    googleMapsUrl: result.googleMapsUri || '',
    reviews,
    reviewLimitNote: 'Google Places API geeft een beperkte selectie reviews terug, niet de volledige reviewhistorie.'
  };
}

export async function findGooglePlace({ store, branchId, googleLocationCode, query, language = 'nl', timeoutMs = 10000 } = {}) {
  const input = buildLookupQuery({ store, branchId, googleLocationCode, query });
  if (!input) throw new Error('Geen winkelnaam of zoekopdracht opgegeven.');

  const data = await fetchGoogleJson(`${GOOGLE_PLACES_NEW_BASE_URL}/places:searchText`, {
    method: 'POST',
    timeoutMs,
    fieldMask: TEXT_SEARCH_FIELD_MASK,
    body: {
      textQuery: input,
      languageCode: language,
      maxResultCount: 1
    }
  });

  const candidate = Array.isArray(data.places) ? data.places[0] : null;
  if (!candidate?.id) {
    throw new Error(`Geen Google place_id gevonden voor ${input}.`);
  }

  return {
    branchId: String(branchId || '').trim(),
    googleLocationCode: String(googleLocationCode || '').trim(),
    store: String(store || input).trim(),
    lookupQuery: input,
    ...normalizePlaceDetails(candidate, 'text-search-new')
  };
}

export async function getGoogleReviewsForStore({
  store,
  branchId,
  googleLocationCode,
  placeId,
  query,
  language = 'nl',
  timeoutMs = 10000,
  allowLookup = false
} = {}) {
  const apiKey = readGoogleApiKey();
  if (!apiKey) throw new Error('GOOGLE_API_KEY ontbreekt in Vercel.');

  const configuredLocation = findConfiguredGoogleStoreLocation({ store, branchId, googleLocationCode });
  const effectiveStore = store || configuredLocation?.store || '';
  const effectiveBranchId = branchId || configuredLocation?.branchId || '';
  const effectiveGoogleLocationCode = googleLocationCode || configuredLocation?.googleLocationCode || '';

  let resolvedPlaceId = normalizePlaceId(placeId || configuredLocation?.placeId || '') || resolveMappedPlaceId({
    store: effectiveStore,
    branchId: effectiveBranchId,
    googleLocationCode: effectiveGoogleLocationCode
  });
  let lookup = null;

  if (!resolvedPlaceId && allowLookup) {
    lookup = await findGooglePlace({
      store: effectiveStore,
      branchId: effectiveBranchId,
      googleLocationCode: effectiveGoogleLocationCode,
      query,
      language,
      timeoutMs
    });
    resolvedPlaceId = normalizePlaceId(lookup.placeId);
  }

  if (!resolvedPlaceId) {
    throw new Error(
      `Geen Google place_id ingesteld voor ${effectiveStore || effectiveBranchId || 'deze winkel'}. Voeg placeId toe aan GOOGLE_STORE_LOCATIONS_JSON, voeg GOOGLE_PLACE_IDS_JSON toe of gebruik lookup=true.`
    );
  }

  const data = await fetchGoogleJson(`${GOOGLE_PLACES_NEW_BASE_URL}/places/${encodeURIComponent(resolvedPlaceId)}?languageCode=${encodeURIComponent(language)}`, {
    method: 'GET',
    timeoutMs,
    fieldMask: PLACE_DETAILS_FIELD_MASK
  });

  return {
    branchId: String(effectiveBranchId || '').trim(),
    googleLocationCode: String(effectiveGoogleLocationCode || '').trim(),
    store: String(effectiveStore || data.displayName?.text || '').trim(),
    configuredPlaceId: normalizePlaceId(placeId || configuredLocation?.placeId || '') || resolveMappedPlaceId({
      store: effectiveStore,
      branchId: effectiveBranchId,
      googleLocationCode: effectiveGoogleLocationCode
    }),
    lookup,
    ...normalizePlaceDetails(data, 'place-details-new')
  };
}
