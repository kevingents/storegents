/**
 * lib/pinterest-client.js
 *
 * Dunne client voor de Pinterest API v5 (read-only analytics). Bearer-token,
 * met optionele automatische token-refresh als een refresh-token + app-creds
 * aanwezig zijn (Pinterest access tokens verlopen).
 *
 * Vercel-env (secrets):
 *   PINTEREST_ACCESS_TOKEN   OAuth-access-token met scopes user_accounts:read,
 *                            pins:read, boards:read (+ analytics).
 *   PINTEREST_REFRESH_TOKEN  (optioneel) refresh-token voor auto-vernieuwen.
 *   PINTEREST_APP_ID         (optioneel) app-id (nodig voor refresh).
 *   PINTEREST_APP_SECRET     (optioneel) app-secret (nodig voor refresh).
 */

const API = 'https://api.pinterest.com/v5';
const clean = (v) => String(v == null ? '' : v).trim();

function cfg() {
  return {
    token: clean(process.env.PINTEREST_ACCESS_TOKEN),
    refreshToken: clean(process.env.PINTEREST_REFRESH_TOKEN),
    appId: clean(process.env.PINTEREST_APP_ID),
    appSecret: clean(process.env.PINTEREST_APP_SECRET)
  };
}

export function pinterestConfigured() { return !!clean(process.env.PINTEREST_ACCESS_TOKEN); }

/* Binnen-proces gecachet vernieuwd token (zodat 1 refresh meerdere calls dekt). */
let refreshedToken = null;

async function refreshAccessToken() {
  const c = cfg();
  if (!c.refreshToken || !c.appId || !c.appSecret) return null;
  try {
    const basic = Buffer.from(`${c.appId}:${c.appSecret}`).toString('base64');
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refreshToken });
    const r = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok && j.access_token) { refreshedToken = j.access_token; return refreshedToken; }
  } catch (_) { /* val terug op fout hieronder */ }
  return null;
}

/**
 * @param {string} path   bv. 'user_account' of `pins/${id}/analytics`.
 * @param {object} params query-params.
 */
export async function pinFetch(path, params = {}, { method = 'GET', timeoutMs = 15000 } = {}) {
  const token = refreshedToken || cfg().token;
  if (!token) { const e = new Error('Geen Pinterest-token (PINTEREST_ACCESS_TOKEN).'); e.code = 'NO_TOKEN'; throw e; }

  const call = async (tk) => {
    const qs = Object.keys(params).length ? `?${new URLSearchParams(params).toString()}` : '';
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${API}/${path}${qs}`, { method, headers: { Authorization: `Bearer ${tk}` }, signal: ctrl.signal });
      const j = await r.json().catch(() => ({}));
      return { r, j };
    } finally { clearTimeout(t); }
  };

  let { r, j } = await call(token);
  if (r.status === 401) {
    const nt = await refreshAccessToken();
    if (nt) ({ r, j } = await call(nt));
  }
  if (!r.ok) {
    const e = new Error((j && (j.message || j.error_description || j.error)) || `Pinterest API fout ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return j;
}
