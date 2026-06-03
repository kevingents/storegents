/**
 * Spotler / MailPlus REST API client.
 *
 * Auth: OAuth 1.0a "one leg" (HMAC-SHA1) — alleen consumer key + secret, geen
 * access-token. Elke call wordt ondertekend.
 *
 * Env:
 *   SPOTLER_CONSUMER_KEY     (verplicht)
 *   SPOTLER_CONSUMER_SECRET  (verplicht)
 *   SPOTLER_API_BASE         (optioneel, default integrationservice-1.1.0)
 *
 * Docs: https://restdoc.mailplus.nl/doc/  ·  base https://restapi.mailplus.nl/
 */

import crypto from 'crypto';

const RAW_BASE = process.env.SPOTLER_API_BASE || 'https://restapi.mailplus.nl/integrationservice-1.1.0';
const BASE = RAW_BASE.replace(/\/+$/, '');

/* RFC3986 percent-encoding (encodeURIComponent laat !*'() vrij — die ook coderen). */
function pct(s) {
  return encodeURIComponent(String(s == null ? '' : s)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

export function hasSpotlerCreds() {
  return Boolean(String(process.env.SPOTLER_CONSUMER_KEY || '').trim() && String(process.env.SPOTLER_CONSUMER_SECRET || '').trim());
}

function getCreds() {
  const key = String(process.env.SPOTLER_CONSUMER_KEY || '').trim();
  const secret = String(process.env.SPOTLER_CONSUMER_SECRET || '').trim();
  if (!key || !secret) throw new Error('SPOTLER_CONSUMER_KEY / SPOTLER_CONSUMER_SECRET ontbreken in Vercel.');
  return { key, secret };
}

/* Bouw de OAuth 1.0a Authorization-header (one-legged: lege token-secret). */
function buildAuthHeader(method, fullUrl, query, key, secret) {
  const oauth = {
    oauth_consumer_key: key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0'
  };

  /* Signature base: oauth-params + query-params (JSON-body telt NIET mee). */
  const all = { ...query, ...oauth };
  const normalized = Object.keys(all)
    .map((k) => [pct(k), pct(all[k])])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const u = new URL(fullUrl);
  const baseUri = `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  const baseString = `${method.toUpperCase()}&${pct(baseUri)}&${pct(normalized)}`;
  const signingKey = `${pct(secret)}&`; // one-legged → geen token-secret
  oauth.oauth_signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');

  return 'OAuth ' + Object.keys(oauth).sort().map((k) => `${pct(k)}="${pct(oauth[k])}"`).join(', ');
}

/**
 * Ondertekende request naar de Spotler REST API.
 * @param {string} method  GET/POST/PUT/DELETE
 * @param {string} path    bv. 'mailing' of 'audience'
 * @param {object} opts    { query, body, timeoutMs }
 */
export async function spotlerRequest(method, path, { query = {}, body = null, timeoutMs = 20000 } = {}) {
  const { key, secret } = getCreds();
  const cleanPath = String(path || '').replace(/^\/+/, '');
  const qs = Object.keys(query).map((k) => `${pct(k)}=${pct(query[k])}`).join('&');
  const fullUrl = `${BASE}/${cleanPath}${qs ? `?${qs}` : ''}`;

  const headers = {
    Authorization: buildAuthHeader(method, fullUrl, query, key, secret),
    Accept: 'application/json'
  };
  let payload;
  if (body != null) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }

  /* Helper voor 1 enkele attempt — wordt door retry-loop hieronder hergebruikt. */
  async function attemptOnce() {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let resp;
    try {
      resp = await fetch(fullUrl, { method: method.toUpperCase(), headers, body: payload, signal: ctrl.signal });
    } catch (e) {
      throw new Error(`Kon Spotler niet bereiken: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }

    const text = await resp.text();
    let data;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!resp.ok) {
      const msg = (data && (data.message || data.error)) || (typeof data === 'string' && data ? data.slice(0, 300) : `Spotler HTTP ${resp.status}`);
      const err = new Error(msg);
      err.status = resp.status;
      err.body = data;
      err.retryAfter = Number(resp.headers.get('retry-after') || 0) || null;
      throw err;
    }
    return data;
  }

  /* 429-retry met Retry-After: Spotler kan een hoog volume calls (zoals
     refreshSpotlerMetrics over 24 mailings) rate-limiten. Eén 429 → tot 2×
     opnieuw met exponential backoff (of de Retry-After header als die er is). */
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await attemptOnce();
    } catch (e) {
      lastErr = e;
      if (e.status !== 429 || attempt === 2) throw e;
      const waitMs = (e.retryAfter ? e.retryAfter * 1000 : 0) || Math.min(5000, 500 * Math.pow(2, attempt));
      console.warn(`[spotler] 429 rate-limited, wacht ${waitMs}ms en retry (poging ${attempt + 1}/2)…`);
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

export { BASE as SPOTLER_BASE };
