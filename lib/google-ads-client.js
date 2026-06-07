/**
 * lib/google-ads-client.js
 *
 * Dunne client voor de Google Ads API (REST). Hergebruikt de bestaande Google
 * OAuth-client (GOOGLE_CLIENT_ID/SECRET) en een refresh token.
 *
 * ENV (Vercel):
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET     OAuth-client (gedeeld met Business Profile)
 *   GOOGLE_ADS_REFRESH_TOKEN                    refresh token MET de 'adwords'-scope
 *                                               (valt terug op GOOGLE_BUSINESS_REFRESH_TOKEN)
 *   GOOGLE_ADS_DEVELOPER_TOKEN                  developer token (Ads MCC → API Center) — VERPLICHT voor Ads
 *                                               (valt terug op MANAGER_GOOGLE_TOKEN)
 *   GOOGLE_ADS_CUSTOMER_ID                      te bevragen account (cijfers, streepjes mogen)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID                MCC-account (optioneel, voor manager-toegang)
 *   GOOGLE_ADS_API_VERSION                      default 'v18'
 *
 * Let op: een 'adwords'-scope is NIET hetzelfde als een developer token. Beide
 * zijn nodig. De scope hangt aan het refresh token (op het moment van consent);
 * de developer token vraag je aan in een Google Ads-beheerdersaccount.
 */

import { googleRefreshToken, googleRefreshTokenSource } from './google-oauth-token.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ADWORDS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const DEFAULT_TIMEOUT_MS = Number(process.env.GOOGLE_ADS_TIMEOUT_MS || 20000);

const clean = (v) => String(v == null ? '' : v).trim();
const digits = (v) => clean(v).replace(/\D/g, '');

export function readAdsConfig() {
  return {
    clientId: clean(process.env.GOOGLE_ADS_CLIENT_ID || process.env.GOOGLE_CLIENT_ID),
    clientSecret: clean(process.env.GOOGLE_ADS_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET),
    refreshToken: googleRefreshToken(),
    refreshTokenSource: googleRefreshTokenSource(),
    developerToken: clean(process.env.GOOGLE_ADS_DEVELOPER_TOKEN || process.env.MANAGER_GOOGLE_TOKEN),
    developerTokenSource: process.env.GOOGLE_ADS_DEVELOPER_TOKEN ? 'GOOGLE_ADS_DEVELOPER_TOKEN' : (process.env.MANAGER_GOOGLE_TOKEN ? 'MANAGER_GOOGLE_TOKEN' : ''),
    customerId: digits(process.env.GOOGLE_ADS_CUSTOMER_ID),
    loginCustomerId: digits(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    apiVersion: clean(process.env.GOOGLE_ADS_API_VERSION) || 'v18'
  };
}

let tokenCache = null;

/** refresh_token → access_token. Retourneert { accessToken, scopes:[], expiresAt }. */
export async function getAdsAccessToken() {
  if (tokenCache?.accessToken && tokenCache.expiresAt > Date.now() + 60000) return tokenCache;

  const { clientId, clientSecret, refreshToken } = readAdsConfig();
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID ontbreekt.');
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET ontbreekt.');
  if (!refreshToken) throw new Error('Geen refresh token — zet GOOGLE_REFRESH_TOKEN in Vercel (geautoriseerd met de adwords-scope).');

  const params = new URLSearchParams();
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);
  params.set('refresh_token', refreshToken);
  params.set('grant_type', 'refresh_token');

  const resp = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google OAuth fout ${resp.status}`);
  }
  tokenCache = {
    accessToken: data.access_token,
    scopes: clean(data.scope).split(/\s+/).filter(Boolean),
    expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000
  };
  return tokenCache;
}

function adsHeaders(accessToken, cfg) {
  const h = { Authorization: `Bearer ${accessToken}`, 'developer-token': cfg.developerToken, 'Content-Type': 'application/json' };
  if (cfg.loginCustomerId) h['login-customer-id'] = cfg.loginCustomerId;
  return h;
}

async function adsFetchOnce(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const msg = data?.error?.message || data?.[0]?.error?.message || `Google Ads API fout ${resp.status}`;
      const err = new Error(msg);
      err.status = resp.status;
      err.body = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`Google Ads API timeout na ${timeoutMs}ms.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Google Ads-call met automatic token-refresh bij 401. De tokenCache wordt
 * geclearred en een 2e poging gedaan met een fresh access-token. Voorkomt dat
 * een lang-idle Vercel-instance met verlopen cached token onnodig faalt.
 *
 * Detecteert óók "invalid_grant" tijdens de refresh — dat betekent dat het
 * refresh-token zelf gerevoked is (Workspace-admin trok OAuth in) — en geeft
 * dan een duidelijke melding aan de admin in plaats van een ondoorzichtige fout.
 */
async function adsFetch(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    return await adsFetchOnce(url, options, timeoutMs);
  } catch (e) {
    if (e?.status !== 401) throw e;
    /* 401 → verlopen of ingetrokken access-token; cache wissen en 1× retry'en. */
    tokenCache = null;
    try {
      const { accessToken } = await getAdsAccessToken();
      const cfg = readAdsConfig();
      const retryOpts = { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${accessToken}` } };
      if (cfg.loginCustomerId && retryOpts.headers && !retryOpts.headers['login-customer-id']) {
        retryOpts.headers['login-customer-id'] = cfg.loginCustomerId;
      }
      return await adsFetchOnce(url, retryOpts, timeoutMs);
    } catch (e2) {
      if (/invalid_grant/i.test(e2.message || '')) {
        throw new Error('Google Ads refresh-token gerevoked of verlopen. Vraag een nieuw OAuth-token aan (Google Workspace admin → verifieer scopes).');
      }
      throw e2;
    }
  }
}

/** Accounts waar dit token toegang toe heeft (resourceNames: ['customers/123…']). */
export async function listAccessibleCustomers() {
  const cfg = readAdsConfig();
  if (!cfg.developerToken) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN ontbreekt.');
  const { accessToken } = await getAdsAccessToken();
  const data = await adsFetch(
    `https://googleads.googleapis.com/${cfg.apiVersion}/customers:listAccessibleCustomers`,
    { method: 'GET', headers: adsHeaders(accessToken, cfg) }
  );
  return (data.resourceNames || []).map((r) => String(r).replace(/^customers\//, ''));
}

/** GAQL-query tegen één customer. Retourneert de ruwe results-array. */
export async function gaql(query, { customerId } = {}) {
  const cfg = readAdsConfig();
  const cid = digits(customerId) || cfg.customerId;
  if (!cfg.developerToken) throw new Error('GOOGLE_ADS_DEVELOPER_TOKEN ontbreekt.');
  if (!cid) throw new Error('GOOGLE_ADS_CUSTOMER_ID ontbreekt.');
  const { accessToken } = await getAdsAccessToken();
  const out = [];
  let pageToken = '';
  /* Safety-stop: paginate maximaal 50 pages (50 × API default 10k results = 500k).
     Als Google ooit een bug heeft die altijd dezelfde pageToken teruggeeft loopt
     dit niet oneindig tot Vercel-timeout. */
  let safety = 0;
  do {
    if (safety++ >= 50) {
      console.warn(`[gaql] safety-stop bereikt na 50 pages (laatste pageToken: ${pageToken?.slice(0, 20)}…)`);
      break;
    }
    const body = { query };
    if (pageToken) body.pageToken = pageToken;
    const data = await adsFetch(
      `https://googleads.googleapis.com/${cfg.apiVersion}/customers/${cid}/googleAds:search`,
      { method: 'POST', headers: adsHeaders(accessToken, cfg), body: JSON.stringify(body) }
    );
    for (const r of (data.results || [])) out.push(r);
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return out;
}

/**
 * Diagnose: vertelt precies wat werkt en wat ontbreekt. Gooit nooit — voor de
 * verbindingstest. Retourneert { config, oauth, ads, diagnosis }.
 */
export async function probeGoogleAds() {
  const cfg = readAdsConfig();
  const ENV_KEYS = [
    'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_BUSINESS_REFRESH_TOKEN',
    'GOOGLE_ADS_DEVELOPER_TOKEN', 'MANAGER_GOOGLE_TOKEN', 'GOOGLE_ADS_CUSTOMER_ID', 'GOOGLE_ADS_LOGIN_CUSTOMER_ID'
  ];
  const config = {
    clientId: Boolean(cfg.clientId),
    clientSecret: Boolean(cfg.clientSecret),
    refreshToken: cfg.refreshTokenSource || 'ontbreekt',
    developerToken: Boolean(cfg.developerToken),
    developerTokenSource: cfg.developerTokenSource || 'ontbreekt',
    customerId: Boolean(cfg.customerId),
    loginCustomerId: Boolean(cfg.loginCustomerId),
    apiVersion: cfg.apiVersion,
    envPresent: Object.fromEntries(ENV_KEYS.map((k) => [k, Boolean(clean(process.env[k]))]))
  };

  const oauth = { ok: false, scopes: [], hasAdwordsScope: false };
  try {
    const t = await getAdsAccessToken();
    oauth.ok = true;
    oauth.scopes = t.scopes;
    oauth.hasAdwordsScope = t.scopes.includes(ADWORDS_SCOPE);
  } catch (e) {
    oauth.error = e.message;
  }

  let ads = null;
  if (oauth.ok && cfg.developerToken) {
    ads = { ok: false };
    try {
      ads.accessibleCustomers = await listAccessibleCustomers();
      ads.ok = true;
    } catch (e) {
      ads.error = e.message;
    }
  } else {
    ads = { skipped: !oauth.ok ? 'OAuth mislukte' : 'developer token ontbreekt' };
  }

  /* Menselijke diagnose: eerste blokkade die telt. */
  let diagnosis;
  if (!oauth.ok) diagnosis = `OAuth-token kon niet ververst worden: ${oauth.error}. Controleer GOOGLE_CLIENT_ID/SECRET + refresh token.`;
  else if (!oauth.hasAdwordsScope) diagnosis = 'Token werkt, maar mist de adwords-scope. Het refresh token is gemint zónder Google Ads-scope — opnieuw autoriseren met scope https://www.googleapis.com/auth/adwords en als GOOGLE_ADS_REFRESH_TOKEN opslaan.';
  else if (!cfg.developerToken) diagnosis = 'OAuth + adwords-scope OK. Nu nog een GOOGLE_ADS_DEVELOPER_TOKEN nodig (aanvragen in een Google Ads-beheerdersaccount → API Center).';
  else if (ads && ads.error) diagnosis = `Ads-API gaf een fout: ${ads.error}.${cfg.customerId ? '' : ' Stel ook GOOGLE_ADS_CUSTOMER_ID in.'}`;
  else if (ads && ads.ok) diagnosis = `Verbinding werkt. ${ads.accessibleCustomers.length} toegankelijk(e) account(s). Stel GOOGLE_ADS_CUSTOMER_ID in op het te bevragen account${cfg.customerId ? ` (nu: ${cfg.customerId})` : ''}.`;
  else diagnosis = 'Onbekende status.';

  return { config, oauth, ads, diagnosis };
}
