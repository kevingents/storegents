/**
 * lib/ga4-client.js
 *
 * Dunne client voor de Google Analytics Data API (GA4, analyticsdata v1beta).
 * Hergebruikt het unified Google OAuth-token (GOOGLE_REFRESH_TOKEN, scope
 * analytics.readonly) en draait read-only runReport-queries.
 *
 * ENV (Vercel):
 *   GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET   OAuth-client (gedeeld met Ads/Business)
 *   GOOGLE_REFRESH_TOKEN                       token MET analytics.readonly-scope
 *   GA4_PROPERTY_ID                            GA4 property-ID (cijfers, bv 123456789)
 */

import { googleRefreshToken, googleOAuthClient } from './google-oauth-token.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';
const DATA_API = 'https://analyticsdata.googleapis.com/v1beta';
const DEFAULT_TIMEOUT_MS = Number(process.env.GA4_TIMEOUT_MS || 20000);

const clean = (v) => String(v == null ? '' : v).trim();
const digits = (v) => clean(v).replace(/\D/g, '');

export function readGa4Config() {
  const { clientId, clientSecret } = googleOAuthClient();
  return {
    clientId,
    clientSecret,
    refreshToken: googleRefreshToken(),
    propertyId: digits(process.env.GA4_PROPERTY_ID || process.env.GOOGLE_ANALYTICS_PROPERTY_ID)
  };
}

let tokenCache = null;

/** refresh_token → access_token. Retourneert { accessToken, scopes:[], expiresAt }. */
export async function getGa4AccessToken() {
  if (tokenCache?.accessToken && tokenCache.expiresAt > Date.now() + 60000) return tokenCache;
  const { clientId, clientSecret, refreshToken } = readGa4Config();
  if (!clientId) throw new Error('GOOGLE_CLIENT_ID ontbreekt.');
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET ontbreekt.');
  if (!refreshToken) throw new Error('Geen refresh token — zet GOOGLE_REFRESH_TOKEN in Vercel (geautoriseerd met analytics.readonly).');

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

async function ga4FetchOnce(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const err = new Error(data?.error?.message || `GA4 API fout ${resp.status}`);
      err.status = resp.status;
      err.body = data;
      throw err;
    }
    return data;
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error(`GA4 API timeout na ${timeoutMs}ms.`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** runReport tegen de geconfigureerde property; retry 1× bij 401 (verlopen token). */
export async function ga4RunReport(body, { propertyId } = {}) {
  const cfg = readGa4Config();
  const pid = digits(propertyId) || cfg.propertyId;
  if (!pid) throw new Error('GA4_PROPERTY_ID ontbreekt.');
  const { accessToken } = await getGa4AccessToken();
  const url = `${DATA_API}/properties/${pid}:runReport`;
  const opts = {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  };
  try {
    return await ga4FetchOnce(url, opts);
  } catch (e) {
    if (e?.status !== 401) throw e;
    tokenCache = null;
    const { accessToken: fresh } = await getGa4AccessToken();
    return ga4FetchOnce(url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${fresh}` } });
  }
}

/**
 * Diagnose voor de verbindingstest. Gooit nooit. Retourneert { config, oauth, ga4, diagnosis }.
 */
export async function probeGa4() {
  const cfg = readGa4Config();
  const out = {
    config: {
      clientId: Boolean(cfg.clientId),
      clientSecret: Boolean(cfg.clientSecret),
      refreshToken: Boolean(cfg.refreshToken),
      propertyId: cfg.propertyId || null
    },
    oauth: { ok: false, hasAnalyticsScope: false },
    ga4: null
  };

  try {
    const t = await getGa4AccessToken();
    out.oauth.ok = true;
    out.oauth.scopes = t.scopes;
    out.oauth.hasAnalyticsScope = t.scopes.includes(ANALYTICS_SCOPE);
  } catch (e) {
    out.oauth.error = e.message;
  }

  if (out.oauth.ok && cfg.propertyId) {
    out.ga4 = { ok: false };
    try {
      const r = await ga4RunReport({ dateRanges: [{ startDate: '7daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] });
      out.ga4.ok = true;
      out.ga4.sampleSessions = Number(r?.rows?.[0]?.metricValues?.[0]?.value || 0) || 0;
    } catch (e) {
      out.ga4.error = e.message;
    }
  } else {
    out.ga4 = { skipped: !out.oauth.ok ? 'OAuth mislukte' : 'GA4_PROPERTY_ID ontbreekt' };
  }

  let diagnosis;
  if (!out.oauth.ok) diagnosis = `OAuth-token kon niet ververst worden: ${out.oauth.error}. Check GOOGLE_CLIENT_ID/SECRET + GOOGLE_REFRESH_TOKEN.`;
  else if (!out.oauth.hasAnalyticsScope) diagnosis = 'Token werkt, maar mist de analytics.readonly-scope. Haal het token opnieuw op met die scope erbij.';
  else if (!cfg.propertyId) diagnosis = 'OAuth + scope OK. Stel nog GA4_PROPERTY_ID in (GA4 → Beheer → Property-instellingen, een getal).';
  else if (out.ga4 && out.ga4.error) diagnosis = `GA4 API gaf een fout: ${out.ga4.error}. Heeft dit Google-account toegang tot property ${cfg.propertyId}?`;
  else if (out.ga4 && out.ga4.ok) diagnosis = `Verbinding werkt. ${out.ga4.sampleSessions} sessies (laatste 7 dagen) op property ${cfg.propertyId}.`;
  else diagnosis = 'Onbekende status.';
  out.diagnosis = diagnosis;
  return out;
}
