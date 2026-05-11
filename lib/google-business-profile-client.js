const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_BUSINESS_BASE_URL = 'https://mybusiness.googleapis.com/v4';
const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_BUSINESS_TIMEOUT_MS || 15000);

function clean(value) {
  return String(value || '').trim();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function readConfig() {
  const clientId = clean(process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_BUSINESS_CLIENT_ID);
  const clientSecret = clean(process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_BUSINESS_CLIENT_SECRET);
  const refreshToken = clean(process.env.GOOGLE_BUSINESS_REFRESH_TOKEN);
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID ontbreekt in Vercel.');
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET ontbreekt in Vercel.');
  if (!refreshToken) throw new Error('GOOGLE_BUSINESS_REFRESH_TOKEN ontbreekt in Vercel.');
  return { clientId, clientSecret, refreshToken };
}

function normalizeLocationName(value = '') {
  return clean(value).replace(/^accounts\/[^/]+\/locations\//, '').replace(/^locations\//, '');
}

function normalizeAccountName(value = '') {
  return clean(value).replace(/^accounts\//, '');
}

function getStoreLocations() {
  const value = safeJson(process.env.GOOGLE_BUSINESS_LOCATIONS_JSON, []);
  return Array.isArray(value) ? value : [];
}

function normalizeKey(value) {
  return clean(value).toLowerCase().replace(/\s+/g, ' ');
}

export function findConfiguredBusinessLocation({ store = '', branchId = '', locationId = '' } = {}) {
  const storeKey = normalizeKey(store);
  const id = clean(branchId);
  const loc = normalizeLocationName(locationId);
  return getStoreLocations().find((location) => {
    if (id && clean(location.branchId) === id) return true;
    if (loc && normalizeLocationName(location.locationId || location.name) === loc) return true;
    if (storeKey && normalizeKey(location.store) === storeKey) return true;
    return false;
  }) || null;
}

let tokenCache = null;

export async function getGoogleBusinessAccessToken() {
  if (tokenCache?.accessToken && tokenCache.expiresAt > Date.now() + 60000) return tokenCache.accessToken;

  const { clientId, clientSecret, refreshToken } = readConfig();
  const params = new URLSearchParams();
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);
  params.set('refresh_token', refreshToken);
  params.set('grant_type', 'refresh_token');

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google OAuth token fout: ${response.status}`);
  }

  tokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return tokenCache.accessToken;
}

async function fetchBusinessJson(path, { timeoutMs = DEFAULT_TIMEOUT_MS, query = {} } = {}) {
  const accessToken = await getGoogleBusinessAccessToken();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(`${GOOGLE_BUSINESS_BASE_URL}${path}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== '') url.searchParams.set(key, String(value));
  });

  try {
    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.error?.message || data?.message || `Google Business API fout: ${response.status}`;
      throw new Error(message);
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Google Business API timeout na ${timeoutMs}ms.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function listBusinessAccounts() {
  const data = await fetchBusinessJson('/accounts');
  return (data.accounts || []).map((account) => ({
    name: account.name || '',
    accountId: normalizeAccountName(account.name),
    accountName: account.accountName || '',
    type: account.type || '',
    role: account.role || '',
    raw: account
  }));
}

export async function listBusinessLocations({ accountId = '', pageSize = 100, pageToken = '' } = {}) {
  const configuredAccountId = clean(accountId || process.env.GOOGLE_BUSINESS_ACCOUNT_ID);
  if (!configuredAccountId) throw new Error('GOOGLE_BUSINESS_ACCOUNT_ID ontbreekt. Haal eerst accounts op.');
  const data = await fetchBusinessJson(`/accounts/${encodeURIComponent(normalizeAccountName(configuredAccountId))}/locations`, {
    query: { pageSize, pageToken }
  });
  return {
    locations: (data.locations || []).map((location) => ({
      name: location.name || '',
      locationId: normalizeLocationName(location.name),
      title: location.locationName || location.title || '',
      address: location.address || null,
      metadata: location.metadata || null,
      raw: location
    })),
    nextPageToken: data.nextPageToken || ''
  };
}

function normalizeReview(review = {}) {
  return {
    reviewId: review.reviewId || review.name || '',
    reviewer: review.reviewer || null,
    reviewerName: review.reviewer?.displayName || '',
    starRating: review.starRating || '',
    rating: Number({ ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 }[review.starRating] || review.starRating || 0),
    comment: review.comment || '',
    createTime: review.createTime || '',
    updateTime: review.updateTime || '',
    reviewReply: review.reviewReply || null,
    raw: review
  };
}

export async function listBusinessReviews({ accountId = '', locationId = '', store = '', branchId = '', pageSize = 50, pageToken = '', orderBy = 'updateTime desc' } = {}) {
  const configuredLocation = findConfiguredBusinessLocation({ store, branchId, locationId });
  const effectiveAccountId = normalizeAccountName(accountId || process.env.GOOGLE_BUSINESS_ACCOUNT_ID || configuredLocation?.accountId || '');
  const effectiveLocationId = normalizeLocationName(locationId || configuredLocation?.locationId || configuredLocation?.name || '');
  if (!effectiveAccountId) throw new Error('GOOGLE_BUSINESS_ACCOUNT_ID ontbreekt.');
  if (!effectiveLocationId) throw new Error(`Geen Google Business locationId ingesteld voor ${store || branchId || 'deze winkel'}.`);

  const data = await fetchBusinessJson(`/accounts/${encodeURIComponent(effectiveAccountId)}/locations/${encodeURIComponent(effectiveLocationId)}/reviews`, {
    query: { pageSize: Math.min(50, Math.max(1, Number(pageSize || 50))), pageToken, orderBy }
  });

  const reviews = (data.reviews || []).map(normalizeReview);
  return {
    success: true,
    source: 'Google Business Profile',
    accountId: effectiveAccountId,
    locationId: effectiveLocationId,
    store: store || configuredLocation?.store || '',
    branchId: branchId || configuredLocation?.branchId || '',
    averageRating: Number(data.averageRating || 0),
    rating: Number(data.averageRating || 0),
    totalReviewCount: Number(data.totalReviewCount || 0),
    reviewCount: Number(data.totalReviewCount || reviews.length || 0),
    reviews,
    nextPageToken: data.nextPageToken || '',
    updatedAt: new Date().toISOString()
  };
}
