/**
 * GET /api/admin/marketing-analytics?period=week|month|year|today
 *
 * Gecombineerde marketing-data voor het dashboard:
 *   - GA4-verkeer + conversies (sessies, gebruikers, omzet, conversie, per kanaal)
 *   - Google Ads gesplitst in Shopping- vs Winkel-advertenties (spend/clicks/conv)
 *
 * Fail-soft per bron: niet gekoppeld → ok:false met uitleg, de rest blijft werken.
 * In-memory cache 30 min (?refresh=1 omzeilt). Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { getGa4Traffic } from '../../lib/ga4-traffic.js';
import { getGoogleAdsCampaigns } from '../../lib/google-ads-spend.js';

export const maxDuration = 60;

const CACHE = new Map();
const TTL_MS = Number(process.env.MARKETING_ANALYTICS_CACHE_MS || 30 * 60 * 1000) || 30 * 60 * 1000;
const ymd = (d) => d.toISOString().slice(0, 10);

function computeRange(period) {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);
  if (period === 'week') { from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0); }
  else if (period === 'year') { from.setFullYear(from.getFullYear() - 1); from.setHours(0, 0, 0, 0); }
  else if (period === 'today') { from.setHours(0, 0, 0, 0); }
  else { from.setDate(from.getDate() - 30); from.setHours(0, 0, 0, 0); } /* month = default */
  to.setHours(23, 59, 59, 999);
  return { from, to };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const period = String(req.query.period || 'month').toLowerCase();
  const qFrom = String(req.query.from || '').trim();
  const qTo = String(req.query.to || '').trim();
  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());

  const cacheKey = `${period}|${qFrom}|${qTo}`;
  const hit = CACHE.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.ts < TTL_MS) {
    return res.status(200).json({ ...hit.payload, cached: true, cacheAgeMs: Date.now() - hit.ts });
  }

  /* Expliciete datums (from/to) winnen van de periode-naam — zo volgt deze call
     exact dezelfde range als POAS en running-ads. */
  const validRange = qFrom && qTo && !Number.isNaN(Date.parse(qFrom)) && !Number.isNaN(Date.parse(qTo));
  const { from, to } = validRange
    ? { from: new Date(`${qFrom}T00:00:00`), to: new Date(`${qTo}T23:59:59`) }
    : computeRange(period);

  const [ga4, google] = await Promise.all([
    getGa4Traffic({ from, to }).catch((e) => ({ ok: false, byChannel: [], error: e.message || 'GA4-fout' })),
    getGoogleAdsCampaigns({ from, to }).catch((e) => ({ ok: false, platform: 'google', campaigns: [], splits: null, spend: 0, error: e.message || 'Ads-fout' }))
  ]);

  /* Campagnes per emmer (max 40) — genoeg om per winkel/stad te filteren. */
  const topPer = (bucket) => (google.campaigns || []).filter((c) => c.bucket === bucket).slice(0, 40);
  const googleOut = {
    ok: !!google.ok,
    spend: google.spend || 0,
    splits: google.splits || null,
    error: google.ok ? undefined : google.error,
    shoppingCampaigns: topPer('shopping'),
    winkelCampaigns: topPer('winkel')
  };

  const payload = {
    success: true,
    period,
    range: { from: ymd(from), to: ymd(to) },
    ga4,
    google: googleOut
  };

  CACHE.set(cacheKey, { ts: Date.now(), payload });
  if (CACHE.size > 20) CACHE.delete(CACHE.keys().next().value);
  return res.status(200).json({ ...payload, cached: false });
}
