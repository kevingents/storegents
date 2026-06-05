/**
 * lib/bol-client.js
 *
 * Client voor de bol.com Retailer API (OAuth2 client-credentials). Faalt netjes
 * met {configured:false} als de credentials ontbreken.
 *
 * Resilience: alle calls gaan door één wrapper met retry/backoff op 429 (rate
 * limit, respecteert Retry-After) en 5xx, en een eenmalige token-refresh-retry
 * bij 401. De token-fetch wordt gedeeld via een in-flight promise zodat
 * gelijktijdige calls niet ieder een eigen token ophalen (race).
 *
 * Vereiste Vercel-env:
 *   BOL_CLIENT_ID          (uit bol partnerplatform → instellingen → API)
 *   BOL_CLIENT_SECRET
 * Optioneel:
 *   BOL_API_BASE           default https://api.bol.com
 *   BOL_API_VERSION        default v10
 *   BOL_DEMO               '1' → gebruik de demo-omgeving (/retailer-demo)
 *   BOL_TIMEOUT_MS         default 15000   (per request)
 *   BOL_RETRY_MAX          default 3       (extra pogingen bij 429/5xx/timeout)
 */

const TOKEN_URL = 'https://login.bol.com/token';
const TIMEOUT_MS = Number(process.env.BOL_TIMEOUT_MS || 15000);
const RETRY_MAX = Number(process.env.BOL_RETRY_MAX || 3);

const clean = (v) => String(v == null ? '' : v).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* Exponentiële backoff met jitter, geplafonneerd op 8s. */
const backoffMs = (attempt) => Math.min(8000, 400 * Math.pow(2, attempt)) + Math.floor(Math.random() * 200);

/* bol eist op sommige endpoints een geldige Accept-Language (nl, nl-BE, fr,
   fr-BE) — geen wildcard. We zetten 'm expliciet om een 406 te voorkomen. */
const ACCEPT_LANGUAGE = clean(process.env.BOL_LANGUAGE) || 'nl';

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

/* ── Token: gecached + in-flight-promise (geen dubbele token-fetches). ──── */
let __tok = { value: '', exp: 0 };
let __tokPromise = null;

async function fetchToken(cfg) {
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

async function getToken(cfg, force = false) {
  /* 60s veiligheidsmarge: voorkomt dat een token midden in een lange sync verloopt. */
  if (!force && __tok.value && Date.now() < __tok.exp - 60000) return __tok.value;
  if (force) __tok = { value: '', exp: 0 };
  if (!__tokPromise) __tokPromise = fetchToken(cfg).finally(() => { __tokPromise = null; });
  return __tokPromise;
}

/* ── Eén fetch met timeout + retry op 429/5xx/timeout. ─────────────────── */
async function bolFetch(url, init, { retries = RETRY_MAX } = {}) {
  let attempt = 0;
  for (;;) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(t);
      if (attempt < retries && (e.name === 'AbortError' || e.name === 'TypeError')) {
        attempt += 1; await sleep(backoffMs(attempt)); continue;
      }
      throw e.name === 'AbortError' ? new Error(`bol timeout na ${TIMEOUT_MS}ms (${url})`) : e;
    }
    clearTimeout(t);
    if ((resp.status === 429 || resp.status >= 500) && attempt < retries) {
      const ra = Number(resp.headers.get('retry-after'));
      attempt += 1;
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 30000) : backoffMs(attempt));
      continue;
    }
    return resp;
  }
}

/* Voer een geauthenticeerde call uit; bij 401 of 403 één keer token verversen
   + retry. Bol returnt soms 403 op een endpoint waar de token oud-gecached is
   met andere scope (na env-rotatie of demo↔prod-switch). Een vers token lost
   dat op; een echt permissie-probleem geeft daarna gewoon weer 403 — dan
   bubblet de error op. */
async function withAuth(cfg, build) {
  let token = await getToken(cfg);
  let resp = await bolFetch(...build(token));
  if (resp.status === 401 || resp.status === 403) {
    token = await getToken(cfg, true);
    resp = await bolFetch(...build(token));
  }
  return resp;
}

/**
 * Gepaginecte GET tegen de Retailer API. `path` start ná het retailer-prefix,
 * bv. '/returns'. Retourneert het geparste JSON-object.
 */
export async function bolGet(path, { query = {}, page } = {}) {
  const cfg = getBolConfig();
  if (!cfg.configured) throw new Error(`bol niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}`);
  const qs = new URLSearchParams(query);
  if (page) qs.set('page', String(page));
  const url = `${cfg.base}${cfg.prefix}${path}${qs.toString() ? '?' + qs.toString() : ''}`;
  const resp = await withAuth(cfg, (token) => [url, {
    headers: { Authorization: `Bearer ${token}`, Accept: `application/vnd.retailer.${cfg.version}+json`, 'Accept-Language': ACCEPT_LANGUAGE }
  }]);
  if (resp.status === 404) return {};
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!resp.ok) throw new Error(`bol ${path} (${resp.status}): ${clean(data?.detail || data?.title || text.slice(0, 200))}`);
  return data;
}

/** GET die CSV teruggeeft (bv. offers-export download). Retourneert ruwe tekst. */
export async function bolGetCsv(path) {
  const cfg = getBolConfig();
  if (!cfg.configured) throw new Error(`bol niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}`);
  const url = `${cfg.base}${cfg.prefix}${path}`;
  const resp = await withAuth(cfg, (token) => [url, {
    headers: { Authorization: `Bearer ${token}`, Accept: `application/vnd.retailer.${cfg.version}+csv`, 'Accept-Language': ACCEPT_LANGUAGE }
  }]);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`bol ${path} (${resp.status}): ${clean(text.slice(0, 200))}`);
  return text;
}

/** Poll een bol-proces (export e.d.) tot SUCCESS/FAILURE of timeout.
 *
 * Stale-detect: een processStatusId van een eerdere Bol-account / omgeving
 * geeft 403 (Unauthorized request) of 404 (Not Found). Dan returnen we
 * { status: 'STALE', stale: true } zodat de caller weet dat de pending-state
 * uit de blob verwijderd kan worden i.p.v. eindeloos blijven retryen. */
async function safeProcessStatus(id) {
  try {
    return await bolGet(`/shared/process-status/${id}`);
  } catch (e) {
    const msg = String(e?.message || '');
    if (/\((403|404)\)/.test(msg)) {
      console.warn(`[bol-client] process-status ${id} → stale (${msg.match(/\((\d+)\)/)?.[1]})`);
      return { status: 'STALE', stale: true, processStatusId: id, errorMessage: msg };
    }
    throw e;
  }
}

export async function bolWaitForProcess(processStatusId, { maxWaitMs = 50000, intervalMs = 3000 } = {}) {
  const id = clean(processStatusId);
  if (!id) throw new Error('Geen processStatusId.');
  const start = Date.now();
  let status = await safeProcessStatus(id);
  while ((Date.now() - start) < maxWaitMs) {
    const s = clean(status?.status).toUpperCase();
    if (s === 'SUCCESS') return status;
    if (s === 'STALE') return status; /* niet-bestaand ID — caller cleant blob */
    if (s === 'FAILURE' || s === 'TIMEOUT') throw new Error(`bol-proces ${s}: ${clean(status?.errorMessage || status?.description)}`);
    await sleep(intervalMs);
    status = await safeProcessStatus(id);
  }
  return status; /* nog niet klaar — caller beslist (pending) */
}

/**
 * POST/PUT tegen de Retailer API (write). Alleen aanroepen bij een echte push.
 * Retry op 429/5xx is veilig: de bol-writes hier zijn idempotent (stock-PUT zet
 * een absoluut aantal; content-push merge't op EAN).
 */
export async function bolPost(path, body, { method = 'POST' } = {}) {
  const cfg = getBolConfig();
  if (!cfg.configured) throw new Error(`bol niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}`);
  const url = `${cfg.base}${cfg.prefix}${path}`;
  const payload = JSON.stringify(body);
  const resp = await withAuth(cfg, (token) => [url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: `application/vnd.retailer.${cfg.version}+json`,
      'Content-Type': `application/vnd.retailer.${cfg.version}+json`,
      'Accept-Language': ACCEPT_LANGUAGE
    },
    body: payload
  }]);
  const text = await resp.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (!resp.ok) throw new Error(`bol ${method} ${path} (${resp.status}): ${clean(data?.detail || data?.title || text.slice(0, 200))}`);
  return data;
}
