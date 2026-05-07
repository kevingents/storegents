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

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function resolveMappedPlaceId({ store, branchId }) {
  const map = getPlaceIdMap();
  const keys = [
    String(branchId || '').trim(),
    String(store || '').trim(),
    normalizeKey(store)
  ].filter(Boolean);

  for (const key of keys) {
    if (map[key]) return String(map[key]).trim();
  }

  return '';
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

export async function findGooglePlace({ store, branchId, query, language = 'nl', timeoutMs = 10000 } = {}) {
  const apiKey = readGoogleApiKey();
  if (!apiKey) throw new Error('GOOGLE_API_KEY ontbreekt in Vercel.');

  const input = String(query || store || '').trim();
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
    store: String(store || input).trim(),
    ...normalizePlaceDetails(candidate, 'find-place')
  };
}

export async function getGoogleReviewsForStore({
  store,
  branchId,
  placeId,
  query,
  language = 'nl',
  timeoutMs = 10000,
  allowLookup = false
} = {}) {
  const apiKey = readGoogleApiKey();
  if (!apiKey) throw new Error('GOOGLE_API_KEY ontbreekt in Vercel.');

  let resolvedPlaceId = String(placeId || '').trim() || resolveMappedPlaceId({ store, branchId });
  let lookup = null;

  if (!resolvedPlaceId && allowLookup) {
    lookup = await findGooglePlace({ store, branchId, query, language, timeoutMs });
    resolvedPlaceId = lookup.placeId;
  }

  if (!resolvedPlaceId) {
    throw new Error(
      `Geen Google place_id ingesteld voor ${store || branchId || 'deze winkel'}. Voeg GOOGLE_PLACE_IDS_JSON toe of geef placeId mee.`
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
    branchId: String(branchId || '').trim(),
    store: String(store || data.result?.name || '').trim(),
    configuredPlaceId: String(placeId || '').trim() || resolveMappedPlaceId({ store, branchId }),
    lookup,
    ...normalizePlaceDetails(data.result, 'place-details')
  };
}
