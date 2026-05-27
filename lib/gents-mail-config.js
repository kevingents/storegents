import { BUSINESS_CONFIG } from './business-config.js';

export const ADMIN_STORE_NAME = 'GENTS Administratie';

/* DEFAULT_STORE_NAMES was vroeger een gedupliceerde array (19 entries hier,
   24 in branch-metrics, 24 met fantoom-winkels in portal-v6.liquid).
   Driften garandeerden dat UI winkels toonde zonder backend-mapping.

   Nu: alleen retail-winkels uit de single source (BUSINESS_CONFIG.branches).
   Magazijn/Showroom/Brandstores blijven via een aparte lijst eronder. */
export const DEFAULT_STORE_NAMES = BUSINESS_CONFIG.branches.list
  .filter((b) => b.kind === 'retail')
  .map((b) => b.store);

export function splitList(value) {
  return String(value || '')
    .split(/[\n,;]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function getApiBaseUrl(req) {
  const configured = String(process.env.GENTS_API_BASE_URL || process.env.NEXT_PUBLIC_GENTS_API_BASE_URL || '').trim().replace(/\/$/, '');
  if (configured) return configured;

  const host = req?.headers?.host || process.env.VERCEL_URL || '';
  const proto = host.includes('localhost') ? 'http' : 'https';
  return host ? `${proto}://${host}` : '';
}

export function getAdminToken() {
  return String(process.env.GENTS_ADMIN_TOKEN || process.env.ADMIN_TOKEN || process.env.ADMIN_PIN || '').trim();
}

/**
 * Vercel Deployment Protection bypass secret.
 *
 * Als Deployment Protection AAN staat, blokkeert Vercel alle interne
 * fetch()-calls van crons naar productie-endpoints en stuurt in plaats
 * daarvan een HTML-login pagina terug — wat de crons interpreteren als
 * "endpoint gaf HTML terug · Authentication Required".
 *
 * Fix: zet in Vercel Settings → Deployment Protection → "Protection Bypass
 * for Automation" AAN en kopieer het secret naar env-var
 * VERCEL_AUTOMATION_BYPASS_SECRET. Alle interne crons sturen die secret
 * automatisch mee als header bij hun fetch-calls.
 */
export function getProtectionBypassSecret() {
  return String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || process.env.VERCEL_PROTECTION_BYPASS || '').trim();
}

/**
 * Wrapper rondom fetch() voor interne API-calls vanuit crons. Voegt
 * automatisch x-admin-token + x-vercel-protection-bypass headers toe en
 * detecteert HTML-responses (Deployment Protection) zodat de error duidelijk
 * is in de mail-log.
 *
 * Gebruik:
 *   const data = await fetchInternalApi(req, '/api/srs/open-weborders?store=...', {
 *     timeoutMs: 25000
 *   });
 *
 * Throws bij non-2xx of als response HTML is (ipv JSON). Returnt geparsde JSON.
 */
export async function fetchInternalApi(req, path, options = {}) {
  const baseUrl = getApiBaseUrl(req);
  if (!baseUrl) throw new Error('GENTS_API_BASE_URL ontbreekt — kan interne API niet bereiken.');

  const url = path.startsWith('http') ? path : `${baseUrl}${path.startsWith('/') ? '' : '/'}${path}`;
  const bypass = getProtectionBypassSecret();
  const adminToken = getAdminToken();
  const timeoutMs = Number(options.timeoutMs || 25000);

  const headers = {
    Accept: 'application/json',
    ...(adminToken ? { 'x-admin-token': adminToken } : {}),
    ...(bypass ? { 'x-vercel-protection-bypass': bypass, 'x-vercel-set-bypass-cookie': 'true' } : {}),
    ...(options.headers || {})
  };

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    signal: AbortSignal.timeout(timeoutMs)
  });

  const text = await response.text();

  /* Detect HTML response (Deployment Protection of route niet gevonden). */
  const looksLikeHtml = /^\s*<(!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    const titleMatch = text.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'onbekend';
    const hint = bypass ? '' : ' — zet VERCEL_AUTOMATION_BYPASS_SECRET env-var in Vercel om dit te fixen';
    throw new Error(`Endpoint gaf HTML terug (${title} · HTTP ${response.status})${hint}`);
  }

  let data = {};
  try { data = text ? JSON.parse(text) : {}; }
  catch (_e) { throw new Error(`Endpoint gaf geen geldige JSON: ${text.slice(0, 200)}`); }

  if (!response.ok || data.success === false) {
    throw new Error(data.message || data.error || `Endpoint fout ${response.status}`);
  }

  return data;
}

export function getMailFrom() {
  return String(
    process.env.RESEND_FROM_EMAIL ||
    process.env.MAIL_FROM ||
    'GENTS Winkelportaal <noreply@gents.nl>'
  ).trim();
}

export function getReplyTo() {
  return String(process.env.MAIL_REPLY_TO || process.env.RESEND_REPLY_TO || '').trim() || undefined;
}

export function getStoreNames() {
  const fromEnv = splitList(process.env.GENTS_STORES_LIST || process.env.STORES_LIST || '');
  return fromEnv.length ? fromEnv : DEFAULT_STORE_NAMES;
}

export function normalizeStore(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function getExcludedStores() {
  const defaults = ['GENTS Brandstores', 'Magazijn', 'GENTS Magazijn', 'Warehouse'];
  const configured = splitList(process.env.WEBORDER_MAIL_EXCLUDED_STORES || process.env.EXCLUDED_STORES || '');
  return new Set([...defaults, ...configured].map(normalizeStore));
}

export function isExcludedStore(store) {
  return getExcludedStores().has(normalizeStore(store));
}

export function getStoreMailSettings() {
  const fallbackDomain = String(process.env.STORE_MAIL_FALLBACK_DOMAIN || '').trim();
  let parsed = {};

  try {
    parsed = JSON.parse(process.env.GENTS_STORE_MAILS_JSON || process.env.STORE_MAILS_JSON || '{}');
  } catch (error) {
    parsed = {};
  }

  const result = {};

  for (const store of getStoreNames()) {
    const raw = parsed[store] || parsed[normalizeStore(store)] || {};
    const storeEmail = raw.email || raw.storeEmail || raw.to || '';
    const cc = raw.cc || raw.copy || '';
    const regionManagerEmail = raw.regionManagerEmail || raw.regioManagerEmail || raw.managerEmail || raw.rm || '';

    result[store] = {
      store,
      email: storeEmail || (fallbackDomain ? `${normalizeStore(store).replace(/\s+/g, '.')}@${fallbackDomain}` : ''),
      cc: Array.isArray(cc) ? cc : splitList(cc),
      regionManagerEmail: Array.isArray(regionManagerEmail) ? regionManagerEmail : splitList(regionManagerEmail)
    };
  }

  return result;
}

export function getStoreMail(store) {
  const settings = getStoreMailSettings();
  return settings[store] || settings[Object.keys(settings).find((key) => normalizeStore(key) === normalizeStore(store))] || {
    store,
    email: '',
    cc: [],
    regionManagerEmail: []
  };
}

/**
 * Async variant van getStoreMail die ÓÓK kijkt naar de Blob-configuratie
 * uit store-emails-store (admin > Winkel-emailadressen). De Blob wint over
 * de env-var GENTS_STORE_MAILS_JSON voor het email-veld; cc en
 * regionManagerEmail blijven uit env-var komen (die zitten niet in de
 * admin-UI).
 *
 * Gebruik in cron-jobs + admin-endpoints zodat de email die de admin
 * via de UI heeft ingesteld ook daadwerkelijk gebruikt wordt voor
 * reminders.
 */
export async function getStoreMailAsync(store) {
  const envSettings = getStoreMail(store);
  try {
    /* Dynamic import om circulaire-dependency te vermijden met store-emails-store */
    const mod = await import('./store-emails-store.js');
    if (typeof mod.getEmailForStore === 'function') {
      const blobEmail = await mod.getEmailForStore(store);
      if (blobEmail && String(blobEmail).trim()) {
        return { ...envSettings, email: String(blobEmail).trim() };
      }
    }
  } catch (error) {
    console.warn('[getStoreMailAsync] Blob-fallback faalde, gebruik env-var:', error.message);
  }
  return envSettings;
}

/**
 * Async variant van getStoreMailSettings die voor ALLE winkels de Blob
 * checked + env-var als fallback gebruikt. Returnt { store: {email,cc,rm} }.
 */
export async function getStoreMailSettingsAsync() {
  const envSettings = getStoreMailSettings();
  try {
    const mod = await import('./store-emails-store.js');
    if (typeof mod.getAllStoreEmails === 'function') {
      const blobMap = await mod.getAllStoreEmails();
      for (const store of Object.keys(envSettings)) {
        const blobEmail = blobMap[store] || blobMap[normalizeStore(store)];
        if (blobEmail && String(blobEmail).trim()) {
          envSettings[store] = { ...envSettings[store], email: String(blobEmail).trim() };
        }
      }
    }
  } catch (error) {
    console.warn('[getStoreMailSettingsAsync] Blob-fallback faalde, gebruik env-var:', error.message);
  }
  return envSettings;
}

export function readSecret(req, envName) {
  const querySecret = req?.query?.secret || req?.query?.token || '';
  const headerSecret = req?.headers?.['x-cron-secret'] || req?.headers?.['x-mail-secret'] || '';
  const auth = String(req?.headers?.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  const expected = String(process.env[envName] || process.env.CRON_SECRET || '').trim();

  return { expected, received: String(querySecret || headerSecret || bearer || '').trim() };
}

export function requireCronSecret(req, res, envName) {
  const { expected, received } = readSecret(req, envName);
  if (!expected) return true;
  if (expected === received) return true;

  res.status(401).json({
    success: false,
    message: `Niet bevoegd. Controleer ${envName} of CRON_SECRET.`
  });
  return false;
}

export function publicBaseUrl(req) {
  return getApiBaseUrl(req) || String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
}
