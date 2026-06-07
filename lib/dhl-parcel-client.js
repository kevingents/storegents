/**
 * lib/dhl-parcel-client.js
 * ========================
 * DHL Parcel NL API (api-gw.dhlparcel.nl) — authenticatie + geauthenticeerde fetch.
 *
 * Creds (SECRETS) uit Vercel env:
 *   - DHL_API_KEY  : de API-key
 *   - DHL_USERID   : de user-id (let op: de Vercel-var staat als "DHl_USERID" met
 *                    kleine L; env-namen zijn hoofdlettergevoelig, dus we lezen beide).
 *
 * Auth-flow (bevestigd via de DHL-docs):
 *   POST /authenticate/api-key  { userId, key }
 *     → { accessToken, accessTokenExpiration (unix s), refreshToken,
 *         refreshTokenExpiration (unix s), accountNumbers: [] }
 *   Daarna: Authorization: Bearer <accessToken> (geldig ~12u; in-memory gecachet).
 */

const BASE = 'https://api-gw.dhlparcel.nl';

export function dhlUserId() {
  return process.env.DHL_USERID || process.env.DHl_USERID || process.env.DHL_USER_ID || '';
}
export function dhlApiKey() {
  return process.env.DHL_API_KEY || process.env.DHL_KEY || '';
}
export function dhlConfigured() {
  return !!(dhlUserId() && dhlApiKey());
}

let _token = null; /* { accessToken, exp (ms), accountNumbers } */

/** Haal (gecachet) een geldig access-token; ververst automatisch ~1 min vóór expiry. */
export async function getDhlToken({ force = false } = {}) {
  const userId = dhlUserId();
  const key = dhlApiKey();
  if (!userId || !key) throw new Error('DHL niet gekoppeld — stel DHL_API_KEY en DHL_USERID in (Vercel).');
  if (!force && _token && _token.exp - Date.now() > 60000) return _token;

  const r = await fetch(`${BASE}/authenticate/api-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ userId, key })
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`DHL-auth ${r.status} — ${t.slice(0, 180)}`);
  }
  const d = await r.json();
  if (!d.accessToken) throw new Error('DHL-auth: geen accessToken in respons.');
  _token = {
    accessToken: d.accessToken,
    exp: (Number(d.accessTokenExpiration) ? Number(d.accessTokenExpiration) * 1000 : (Date.now() + 11 * 3600 * 1000)),
    accountNumbers: Array.isArray(d.accountNumbers) ? d.accountNumbers : []
  };
  return _token;
}

/** Geauthenticeerde call naar de DHL Parcel API (Bearer-token automatisch). */
export async function dhlFetch(path, { method = 'GET', body, headers = {} } = {}) {
  const tok = await getDhlToken();
  return fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tok.accessToken}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

/** Verbindingstest: authenticeert en geeft account-info + token-geldigheid terug. */
export async function probeDhl() {
  if (!dhlConfigured()) {
    return { ok: false, error: 'DHL_API_KEY of DHL_USERID ontbreekt in Vercel.', hasKey: !!dhlApiKey(), hasUserId: !!dhlUserId() };
  }
  try {
    const tok = await getDhlToken({ force: true });
    return {
      ok: true,
      accountNumbers: tok.accountNumbers,
      accountCount: tok.accountNumbers.length,
      tokenValidUntil: new Date(tok.exp).toISOString()
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
