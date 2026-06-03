import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getGoogleAdsCampaigns } from '../../lib/google-ads-spend.js';
import { getMetaAdsCampaigns } from '../../lib/meta-ads-spend.js';

/**
 * GET /api/admin/running-ads?days=7
 *
 * Lopende advertentiecampagnes (Google Ads ENABLED + Meta ACTIVE) met spend,
 * vertoningen en clicks over de periode. Per platform fail-soft: niet gekoppeld
 * → ok:false met uitleg, de rest blijft werken.
 */

export const maxDuration = 60;

const CACHE = new Map();
const TTL_MS = Number(process.env.RUNNING_ADS_CACHE_MS || 15 * 60 * 1000) || 15 * 60 * 1000;
const ymd = (d) => d.toISOString().slice(0, 10);

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const now = new Date();
  const days = Math.max(1, Math.min(90, Number(req.query.days || 7)));
  const to = String(req.query.to || ymd(now)).trim();
  const from = String(req.query.from || ymd(new Date(Date.now() - (days - 1) * 86400000))).trim();

  const refresh = ['1', 'true'].includes(String(req.query.refresh || ''));
  const cacheKey = `${from}|${to}`;
  const hit = CACHE.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.ts < TTL_MS) {
    return res.status(200).json({ ...hit.payload, cached: true, cacheAgeMs: Date.now() - hit.ts });
  }

  const [google, meta] = await Promise.all([
    getGoogleAdsCampaigns({ from, to }).catch((e) => ({ ok: false, platform: 'google', campaigns: [], spend: 0, error: e.message || 'fout' })),
    getMetaAdsCampaigns({ from, to }).catch((e) => ({ ok: false, platform: 'meta', campaigns: [], spend: 0, error: e.message || 'fout' }))
  ]);

  const totalCampaigns = (google.campaigns?.length || 0) + (meta.campaigns?.length || 0);
  const totalSpend = Math.round(((google.spend || 0) + (meta.spend || 0)) * 100) / 100;

  const payload = {
    success: true,
    from, to, days,
    totalCampaigns,
    totalSpend,
    google,
    meta
  };

  CACHE.set(cacheKey, { ts: Date.now(), payload });
  if (CACHE.size > 40) CACHE.delete(CACHE.keys().next().value);
  return res.status(200).json(payload);
}
