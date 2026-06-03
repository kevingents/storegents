import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';

async function timed(label, key, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return { key, label, status: result?.degraded ? 'warning' : 'ok', message: result?.message || result?.note || 'Endpoint werkt.', durationMs: Date.now() - start, meta: result?.meta || {} };
  } catch (error) {
    return { key, label, status: 'error', message: error.message || 'Endpoint fout.', durationMs: Date.now() - start, meta: {} };
  }
}

function apiBase(req) {
  /* Volgorde is belangrijk i.v.m. Vercel Deployment Protection.
     VERCEL_URL is de deployment-specifieke URL die Protection blokkeert met
     een HTML 401-login — interne fetches daarheen falen dus. De host waarmee
     de admin de portal opende (req.headers.host) is daarentegen het publieke,
     niet-beschermde alias. Daarom: expliciete publieke base eerst, dan de
     request-host, en VERCEL_URL pas als allerlaatste redmiddel. */
  const explicit = String(process.env.PUBLIC_API_BASE_URL || process.env.GENTS_API_BASE_URL || '').trim();
  if (explicit) return explicit.startsWith('http') ? explicit.replace(/\/$/, '') : `https://${explicit.replace(/\/$/, '')}`;
  if (req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${req.headers.host}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL.replace(/\/$/, '')}`;
  return '';
}

function adminToken(req) {
  return String(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.query.adminToken || req.query.admin_token || process.env.ADMIN_TOKEN || '').replace(/^Bearer\s+/i, '').trim();
}

function appendAdminToken(url, token) {
  const u = new URL(url);
  if (token) {
    u.searchParams.set('adminToken', token);
    u.searchParams.set('admin_token', token);
  }
  return u.toString();
}

async function getJson(url, token = '') {
  const finalUrl = appendAdminToken(url, token);
  const headers = { Accept: 'application/json' };
  if (token) headers['x-admin-token'] = token;
  /* Stuur de Deployment-Protection bypass mee voor het geval de base toch
     een beschermde URL is — anders krijgen we een HTML 401-loginpagina terug. */
  const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || process.env.VERCEL_PROTECTION_BYPASS || '').trim();
  if (bypass) headers['x-vercel-protection-bypass'] = bypass;
  const response = await fetch(finalUrl, { headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.success === false) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const base = apiBase(req);
  const store = String(req.query.store || 'GENTS Utrecht').trim();
  const token = adminToken(req);

  /* Helpers voor directe service-checks (geen interne HTTP roundtrip) */
  async function pingShopify() {
    const domain = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN;
    const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN;
    const version = process.env.SHOPIFY_API_VERSION || '2025-01';
    if (!domain || !shopifyToken) throw new Error('Shopify env-vars ontbreken.');
    const url = `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/admin/api/${version}/shop.json`;
    const resp = await fetch(url, { headers: { 'X-Shopify-Access-Token': shopifyToken, Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Shopify ${resp.status}`);
    const data = await resp.json();
    return { message: `Verbonden: ${data.shop?.name || domain}`, meta: { shop: data.shop?.name, plan: data.shop?.plan_name, country: data.shop?.country_name } };
  }

  async function pingReturnista() {
    const rt = process.env.RETURNISTA_API_TOKEN;
    const acc = process.env.RETURNISTA_ACCOUNT_ID;
    if (!rt || !acc) return { degraded: true, message: 'Env-vars niet ingesteld.', meta: {} };
    const url = `https://core.returnista.com/api/v0/account/${acc}/return-requests?limit=1`;
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${rt}`, Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Returnista ${resp.status}`);
    return { message: 'Returnista API bereikbaar.' };
  }

  async function pingSendcloud() {
    const pk = process.env.SENDCLOUD_PUBLIC_KEY;
    const sk = process.env.SENDCLOUD_SECRET_KEY;
    if (!pk || !sk) return { degraded: true, message: 'Env-vars niet ingesteld.', meta: {} };
    const auth = Buffer.from(`${pk}:${sk}`).toString('base64');
    const resp = await fetch('https://panel.sendcloud.sc/api/v2/user', { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Sendcloud ${resp.status}`);
    const data = await resp.json();
    return { message: `Account ${data.user?.username || ''}`.trim(), meta: { username: data.user?.username } };
  }

  async function pingBlobStorage() {
    try {
      const { list } = await import('@vercel/blob');
      const result = await list({ limit: 1 });
      return { message: 'Vercel Blob bereikbaar.', meta: { blobsListed: result.blobs?.length || 0 } };
    } catch (error) {
      throw new Error(`Blob: ${error.message || 'onbereikbaar'}`);
    }
  }

  /** Versheidscheck voor de nachtelijke SRS-bestanden.
   *  Leest de blob-snapshots (geen SFTP-verbinding nodig) en controleert of de
   *  geïmporteerde bestanden niet ouder zijn dan ~28 uur. Geeft 'warning' als
   *  er waarschijnlijk geen nieuw bestand is binnengekomen. */
  async function pingSrsDataFreshness() {
    const { readJsonBlob } = await import('../../lib/json-blob-store.js');
    const STALE_MS = 28 * 60 * 60 * 1000; /* 28 uur — ruim genoeg voor nachtlevering */
    const now = Date.now();

    const checks = await Promise.all([
      readJsonBlob('srs/dragers.json', null).catch(() => null),
      readJsonBlob('srs/retail-performance.json', null).catch(() => null)
    ]);

    const [dragers, retail] = checks;
    const signals = [];

    /* Dragers: refreshedAt in ISO */
    const dragersAge = dragers?.refreshedAt ? now - Date.parse(dragers.refreshedAt) : null;
    if (dragersAge === null) signals.push({ label: 'verplaatsingen', status: 'onbekend', file: null });
    else signals.push({ label: 'verplaatsingen', stale: dragersAge > STALE_MS, ageHours: Math.round(dragersAge / 3600000), file: dragers?.sourceFile || null });

    /* Retail/verkopen: refreshedAt */
    const retailAge = retail?.refreshedAt ? now - Date.parse(retail.refreshedAt) : null;
    if (retailAge === null) signals.push({ label: 'verkopen', status: 'onbekend', file: null });
    else signals.push({ label: 'verkopen', stale: retailAge > STALE_MS, ageHours: Math.round(retailAge / 3600000), file: retail?.sources?.verkopen || null });

    const stale = signals.filter((s) => s.stale);
    const unknown = signals.filter((s) => s.status === 'onbekend');
    if (stale.length > 0) {
      return {
        degraded: true,
        message: `SRS bestanden verouderd (>${STALE_MS / 3600000}u): ${stale.map((s) => `${s.label} (${s.ageHours}u oud)`).join(', ')}. Controleer de nachtlevering via SRS bestanden.`,
        meta: { signals }
      };
    }
    if (unknown.length === signals.length) {
      return { degraded: true, message: 'SRS data-versheid onbekend — snapshots nog niet aanwezig.', meta: { signals } };
    }
    const youngest = signals.filter((s) => s.ageHours != null).sort((a, b) => a.ageHours - b.ageHours)[0];
    return { message: `SRS data vers (nieuwste snapshot: ${youngest?.ageHours ?? '?'}u oud).`, meta: { signals } };
  }

  async function pingResend() {
    const key = process.env.RESEND_API_KEY;
    if (!key) throw new Error('RESEND_API_KEY ontbreekt');
    const resp = await fetch('https://api.resend.com/domains', { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Resend ${resp.status}`);
    const data = await resp.json();
    return { message: 'Resend bereikbaar.', meta: { domains: data.data?.length || 0 } };
  }

  const services = await Promise.all([
    timed('SRS nachtlevering', 'srs_sftp_freshness', pingSrsDataFreshness),
    timed('Shopify Admin API', 'shopify_admin', pingShopify),
    timed('SRS openstaande weborders', 'srs_open_weborders', async () => {
      const data = await getJson(`${base}/api/srs/open-weborders?store=${encodeURIComponent(store)}&t=${Date.now()}`, token);
      return { degraded: data.degraded, note: data.note, meta: { total: data.open, overdue: data.overdue } };
    }),
    timed('Returnista API', 'returnista_api', pingReturnista),
    timed('Sendcloud API', 'sendcloud_api', pingSendcloud),
    timed('Vercel Blob storage', 'blob_storage', pingBlobStorage),
    timed('Resend (mail)', 'resend_mail', pingResend),
    timed('Google reviews', 'google_reviews', async () => {
      const data = await getJson(`${base}/api/google-reviews/summary?store=${encodeURIComponent(store)}&t=${Date.now()}`, token);
      return { degraded: !data.rating, message: data.message, meta: { rating: data.rating, count: data.count } };
    }),
    timed('Mail automatisering', 'mail_automation', async () => {
      const data = await getJson(`${base}/api/admin/mail-automations/status?t=${Date.now()}`, token);
      const disabled = (data.automations || data.services || []).filter((a) => a.enabled === false || a.status === 'disabled').length;
      return { degraded: disabled > 0, message: disabled ? `${disabled} automatisering(en) niet actief.` : 'Mail automatisering actief.', meta: { total: (data.automations || data.services || []).length, disabled } };
    }),
    timed('Mail logs store', 'mail_logs', async () => {
      const data = await getJson(`${base}/api/admin/mail-logs?limit=10&t=${Date.now()}`, token);
      return { message: 'Mail logs opgehaald.', meta: { total: data.count || (data.rows || data.logs || []).length } };
    })
  ]);

  const errorCount = services.filter((s) => s.status === 'error').length;
  const warningCount = services.filter((s) => s.status === 'warning').length;
  const overallStatus = errorCount ? 'error' : warningCount ? 'warning' : 'ok';
  const logs = services.map((service) => ({ time: new Date().toISOString(), level: service.status === 'error' ? 'error' : service.status === 'warning' ? 'warning' : 'info', title: service.label, message: service.message, durationMs: service.durationMs }));

  return res.status(200).json({ success: true, overallStatus, services, logs });
}
