/**
 * lib/google-search-console-client.js
 *
 * Leest Google Search Console (Search Analytics) voor de SEO-ranking-pagina:
 * echte zoektermen, posities, klikken, impressies en CTR. Hergebruikt het
 * bestaande Google-OAuth-patroon (client-id/secret + refresh-token).
 *
 * Vereiste Vercel-env (zodra je het koppelt):
 *   GOOGLE_CLIENT_ID            (gedeeld met andere Google-integraties)
 *   GOOGLE_CLIENT_SECRET
 *   GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN   (scope: webmasters.readonly)
 *   GSC_SITE_URL               bv. 'sc-domain:gents.nl' of 'https://www.gents.nl/'
 *
 * Niet gekoppeld → { configured:false, reason }. Schrijft niets.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SC_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
const TIMEOUT_MS = Number(process.env.GSC_TIMEOUT_MS || 15000);

const clean = (v) => String(v == null ? '' : v).trim();

export function getGscConfig() {
  const clientId = clean(process.env.GOOGLE_CLIENT_ID || process.env.GOOGLE_BUSINESS_CLIENT_ID);
  const clientSecret = clean(process.env.GOOGLE_CLIENT_SECRET || process.env.GOOGLE_BUSINESS_CLIENT_SECRET);
  const refreshToken = clean(process.env.GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN || process.env.GSC_REFRESH_TOKEN);
  const siteUrl = clean(process.env.GSC_SITE_URL || process.env.GOOGLE_SEARCH_CONSOLE_SITE_URL);
  const missing = [];
  if (!clientId) missing.push('GOOGLE_CLIENT_ID');
  if (!clientSecret) missing.push('GOOGLE_CLIENT_SECRET');
  if (!refreshToken) missing.push('GOOGLE_SEARCH_CONSOLE_REFRESH_TOKEN');
  if (!siteUrl) missing.push('GSC_SITE_URL');
  return { clientId, clientSecret, refreshToken, siteUrl, configured: missing.length === 0, missing };
}

export function isGscConfigured() {
  return getGscConfig().configured;
}

async function getAccessToken(cfg) {
  const params = new URLSearchParams();
  params.set('client_id', cfg.clientId);
  params.set('client_secret', cfg.clientSecret);
  params.set('refresh_token', cfg.refreshToken);
  params.set('grant_type', 'refresh_token');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal: ctrl.signal
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || !data.access_token) {
      throw new Error(`Google-token mislukt (${resp.status}): ${clean(data.error_description || data.error || '')}`);
    }
    return data.access_token;
  } finally { clearTimeout(t); }
}

async function scQuery(cfg, accessToken, body) {
  const url = `${SC_BASE}/sites/${encodeURIComponent(cfg.siteUrl)}/searchAnalytics/query`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Search Console (${resp.status}): ${clean(data?.error?.message || '')}`);
    return data.rows || [];
  } finally { clearTimeout(t); }
}

function dateStr(d) { return d.toISOString().slice(0, 10); }

/**
 * Haal een Search Console-samenvatting op over de laatste N dagen.
 * @param {{days?:number, rowLimit?:number}} opts
 * @returns {Promise<object>} { configured, siteUrl, period, totals, topQueries, topPages } of { configured:false }
 */
export async function getSearchConsoleSummary({ days = 28, rowLimit = 25 } = {}) {
  const cfg = getGscConfig();
  if (!cfg.configured) return { configured: false, reason: `Niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}` };

  /* GSC-data loopt ~2-3 dagen achter; eindig 3 dagen terug. */
  const end = new Date(Date.now() - 3 * 86400000);
  const start = new Date(end.getTime() - (days - 1) * 86400000);
  const range = { startDate: dateStr(start), endDate: dateStr(end) };

  try {
    const accessToken = await getAccessToken(cfg);
    const [totalsRows, queryRows, pageRows] = await Promise.all([
      scQuery(cfg, accessToken, { ...range, dimensions: [] }),
      scQuery(cfg, accessToken, { ...range, dimensions: ['query'], rowLimit }),
      scQuery(cfg, accessToken, { ...range, dimensions: ['page'], rowLimit })
    ]);
    const tot = totalsRows[0] || {};
    const mapRow = (r, keyName) => ({
      [keyName]: r.keys?.[0] || '',
      clicks: r.clicks || 0,
      impressions: r.impressions || 0,
      ctr: Math.round((r.ctr || 0) * 1000) / 10, /* % */
      position: Math.round((r.position || 0) * 10) / 10
    });
    return {
      configured: true,
      siteUrl: cfg.siteUrl,
      period: range,
      totals: {
        clicks: tot.clicks || 0,
        impressions: tot.impressions || 0,
        ctr: Math.round((tot.ctr || 0) * 1000) / 10,
        position: Math.round((tot.position || 0) * 10) / 10
      },
      topQueries: queryRows.map((r) => mapRow(r, 'query')),
      topPages: pageRows.map((r) => mapRow(r, 'page'))
    };
  } catch (error) {
    return { configured: true, error: error.message || 'Search Console-fout.' };
  }
}
