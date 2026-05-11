import { getAdminToken, getApiBaseUrl } from '../../lib/gents-mail-config.js';
import { readReportCache, writeReportCache } from '../../lib/gents-report-cache-store.js';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function authorized(req) {
  const expected = getAdminToken() || String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization || req.query.adminToken || req.query.admin_token || req.query.token || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function weekAgo() {
  const date = new Date();
  date.setDate(date.getDate() - 7);
  return date.toISOString().slice(0, 10);
}

function range(req) {
  return {
    from: String(req.query.dateFrom || req.query.from || weekAgo()).slice(0, 10),
    to: String(req.query.dateTo || req.query.to || today()).slice(0, 10)
  };
}

async function fetchLive(req, from, to) {
  const base = getApiBaseUrl(req);
  const token = encodeURIComponent(getAdminToken());
  const url = `${base}/api/admin/scoreboard/omnichannel?dateFrom=${encodeURIComponent(from)}&dateTo=${encodeURIComponent(to)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&adminToken=${token}&admin_token=${token}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }
  if (!response.ok || data.success === false) throw new Error(data.message || data.error || `HTTP ${response.status}`);
  return data;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!authorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const { from, to } = range(req);
  const key = `${from}_${to}`;
  const refresh = String(req.query.refresh || '') === '1' || String(req.query.refresh || '') === 'true';
  const ttlMs = Number(process.env.FAST_OMNICHANNEL_CACHE_MS || 900000);

  if (!refresh) {
    const cached = await readReportCache('omnichannel', key, ttlMs);
    if (cached?.data && !cached.stale) {
      return res.status(200).json({ ...cached.data, fastCache: { hit: true, cachedAt: cached.cachedAt, ageMs: cached.ageMs, key } });
    }
  }

  try {
    const data = await fetchLive(req, from, to);
    await writeReportCache('omnichannel', key, data);
    return res.status(200).json({ ...data, fastCache: { hit: false, key } });
  } catch (error) {
    const cached = await readReportCache('omnichannel', key, 0);
    if (cached?.data) {
      return res.status(200).json({ ...cached.data, degraded: true, warnings: [...(cached.data.warnings || []), `live refresh mislukt: ${error.message}`], fastCache: { hit: true, stale: true, key } });
    }
    return res.status(502).json({ success: false, message: error.message || 'Rapportage laden mislukt.' });
  }
}
