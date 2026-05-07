import { safeJson } from './branch-metrics.js';

const GOOGLE_PLACES_BASE_URL = 'https://maps.googleapis.com/maps/api/place';

const DEFAULT_DETAILS_FIELDS = [
  'place_id',
  'name',
  'formatted_address',
  'business_status',
  'rating',
  'user_ratings_total',
  'reviews',
  'url'
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

function resolveMappedPlaceId({ store, branchId, googleLocationCode }) {
  const map = getPlaceIdMap();
  const keys = [
    String(branchId || '').trim(),
    String(googleLocationCode || '').trim(),
    String(store || '').trim(),
    normalizeKey(store)
  ].filter(Boolean);

  for (const key of keys) {
    if (map[key]) return String(map[key]).trim();
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

function googleStatusMessage(status, errorMessage = '') {
  const message = String(errorMessage || '').trim();
  if (message) return message;

  switch (status) {
    case 'REQUEST_DENIED':
      return 'Google Places aanvraag geweigerd. Controleer GOOGLE_API_KEY, API-restricties en billing.';
    case 'OVER_QUERY_LIMIT':
      return 'Google Places limiet bereikt.';
    case 'ZERO_RESULTS':
      return 'Geen Google locatie gevonden.';
    case 'INVALID_REQUEST':
      return 'Ongeldige Google Places aanvraag.';
    case 'NOT_FOUND':
      return 'Google plaats niet gevonden.';
    default:
      return status ? `Google Places status: ${status}` : 'Onbekende Google Places fout.';
  }
}

async function fetchGoogleJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(`Google HTTP ${response.status}`);
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeReview(review = {}) {
  const unixSeconds = Number(review.time || 0);

  return {
    authorName: review.author_name || '',
    authorUrl: review.author_url || '',
    profilePhotoUrl: review.profile_photo_url || '',
    rating: Number(review.rating || 0),
    text: review.text || '',
    language: review.language || '',
    relativeTimeDescription: review.relative_time_description || '',
    time: unixSeconds || null,
    date: unixSeconds ? new Date(unixSeconds * 1000).toISOString() : ''
  };
}

function normalizePlaceDetails(result = {}, source = 'place-details') {
  const reviews = Array.isArray(result.reviews) ? result.reviews.map(normalizeReview) : [];

  return {
    source,
    placeId: result.place_id || '',
    name: result.name || '',
    address: result.formatted_address || '',
    businessStatus: result.business_status || '',
    rating: Number(result.rating || 0),
    reviewCount: Number(result.user_ratings_total || 0),
    userRatingsTotal: Number(result.user_ratings_total || 0),
    googleMapsUrl: result.url || '',
    reviews,
    reviewLimitNote: 'Google Places geeft standaard alleen een beperkte selectie reviews terug, niet de volledige reviewhistorie.'
  };
}

export async function findGooglePlace({ store, branchId, googleLocationCode, query, language = 'nl', timeoutMs = 10000 } = {}) {
  const apiKey = readGoogleApiKey();
  if (!apiKey) throw new Error('GOOGLE_API_KEY ontbreekt in Vercel.');

  const input = buildLookupQuery({ store, branchId, googleLocationCode, query });
  if (!input) throw new Error('Geen winkelnaam of zoekopdracht opgegeven.');

  const url = new URL(`${GOOGLE_PLACES_BASE_URL}/findplacefromtext/json`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('input', input);
  url.searchParams.set('inputtype', 'textquery');
  url.searchParams.set('fields', 'place_id,name,formatted_address,business_status,rating,user_ratings_total');
  url.searchParams.set('language', language);

  const data = await fetchGoogleJson(url, timeoutMs);

  if (data.status !== 'OK') {
    throw new Error(googleStatusMessage(data.status, data.error_message));
  }

  const candidate = Array.isArray(data.candidates) ? data.candidates[0] : null;
  if (!candidate?.place_id) {
    throw new Error(`Geen Google place_id gevonden voor ${input}.`);
  }

  return {
    branchId: String(branchId || '').trim(),
    googleLocationCode: String(googleLocationCode || '').trim(),
    store: String(store || input).trim(),
    lookupQuery: input,
    ...normalizePlaceDetails(candidate, 'find-place')
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

  let resolvedPlaceId = String(placeId || configuredLocation?.placeId || '').trim() || resolveMappedPlaceId({
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
    resolvedPlaceId = lookup.placeId;
  }

  if (!resolvedPlaceId) {
    throw new Error(
      `Geen Google place_id ingesteld voor ${effectiveStore || effectiveBranchId || 'deze winkel'}. Voeg placeId toe aan GOOGLE_STORE_LOCATIONS_JSON, voeg GOOGLE_PLACE_IDS_JSON toe of gebruik lookup=true.`
    );
  }

  const url = new URL(`${GOOGLE_PLACES_BASE_URL}/details/json`);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('place_id', resolvedPlaceId);
  url.searchParams.set('fields', DEFAULT_DETAILS_FIELDS);
  url.searchParams.set('language', language);
  url.searchParams.set('reviews_sort', 'newest');

  const data = await fetchGoogleJson(url, timeoutMs);

  if (data.status !== 'OK') {
    throw new Error(googleStatusMessage(data.status, data.error_message));
  }

  return {
    branchId: String(effectiveBranchId || '').trim(),
    googleLocationCode: String(effectiveGoogleLocationCode || '').trim(),
    store: String(effectiveStore || data.result?.name || '').trim(),
    configuredPlaceId: String(placeId || configuredLocation?.placeId || '').trim() || resolveMappedPlaceId({
      store: effectiveStore,
      branchId: effectiveBranchId,
      googleLocationCode: effectiveGoogleLocationCode
    }),
    lookup,
    ...normalizePlaceDetails(data.result, 'place-details')
  };
}
