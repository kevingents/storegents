/**
 * lib/bol-client.js
 *
 * Client voor de bol.com Retailer API (OAuth2 client-credentials). Read-only
 * gebruik voor de Marketplace-pagina. Faalt netjes met {configured:false} als
 * de credentials ontbreken.
 *
 * Vereiste Vercel-env:
 *   BOL_CLIENT_ID          (uit bol partnerplatform → instellingen → API)
 *   BOL_CLIENT_SECRET
 * Optioneel:
 *   BOL_API_BASE           default https://api.bol.com
 *   BOL_API_VERSION        default v10
 *   BOL_DEMO               '1' → gebruik de demo-omgeving (/retailer-demo)
 */

const TOKEN_URL = 'https://login.bol.com/token';
const TIMEOUT_MS = Number(process.env.BOL_TIMEOUT_MS || 15000);

const clean = (v) => String(v == null ? '' : v).trim();

export function getBolConfig() {
  const clientId = clean(process.env.BOL_CLIENT_ID);
  const clientSecret = clean(process.env.BOL_CLIENT_SECRET);
  const base = clean(process.env.BOL_API_BASE) || 'https://api.bol.com';
  const version = clean(process.env.BOL_API_VERSION) || 'v10';
  const demo = ['1', 'true', 'yes'].includes(clean(process.env.BOL_DEMO).toLowerCase());
  const prefix = demo ? '/retailer-demo' : '/retailer';
  const missing = [];
  if (!clientId) missing.push('BOL_CLIENT_ID');
  if (!clientSecret) missing.push('BOL_CLIENT_SECRET');
  return { clientId, clientSecret, base, version, demo, prefix, configured: missing.length === 0, missing };
}

export function isBolConfigured() { return getBolConfig().configured; }

let __tok = { value: '', exp: 0 };

async function getToken(cfg) {
  if (__tok.value && Date.now() < __tok.exp - 10000) return __tok.value;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${TOKEN_URL}?grant_type=client_credentials`, {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, Accept: 'application/json' },
      signal: ctrl.signal
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) throw new Error(`bol-token mislukt (${resp.status}): ${clean(data.error_description || data.error || '')}`);
    __tok = { value: data.access_token, exp: Date.now() + (Number(data.expires_in || 300) * 1000) };
    return __tok.value;
  } finally { clearTimeout(t); }
}

/**
 * Gepaginecte GET tegen de Retailer API. `path` start ná het retailer-prefix,
 * bv. '/returns'. Retourneert het geparste JSON-object.
 */
export async function bolGet(path, { query = {}, page } = {}) {
  const cfg = getBolConfig();
  if (!cfg.configured) throw new Error(`bol niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}`);
  const token = await getToken(cfg);
  const qs = new URLSearchParams(query);
  if (page) qs.set('page', String(page));
  const url = `${cfg.base}${cfg.prefix}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: `application/vnd.retailer.${cfg.version}+json` },
      signal: ctrl.signal
    });
    if (resp.status === 404) return {};
    const text = await resp.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    if (!resp.ok) throw new Error(`bol ${path} (${resp.status}): ${clean(data?.detail || data?.title || text.slice(0, 200))}`);
    return data;
  } finally { clearTimeout(t); }
}
