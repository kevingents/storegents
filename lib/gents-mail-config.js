export const ADMIN_STORE_NAME = 'GENTS Administratie';

export const DEFAULT_STORE_NAMES = [
  'GENTS Brandstores',
  'GENTS Almere',
  'GENTS Amersfoort',
  'GENTS Amsterdam',
  'GENTS Antwerpen',
  'GENTS Arnhem',
  'GENTS Breda',
  'GENTS Delft',
  'GENTS Den Bosch',
  'GENTS Enschede',
  'GENTS Groningen',
  'GENTS Hilversum',
  'GENTS Leiden',
  'GENTS Maastricht',
  'GENTS Nijmegen',
  'GENTS Rotterdam',
  'GENTS Tilburg',
  'GENTS Utrecht',
  'GENTS Zoetermeer',
  'GENTS Zwolle'
];

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
