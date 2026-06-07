/**
 * GET /api/admin/marketing-search-terms?from=YYYY-MM-DD&to=YYYY-MM-DD
 * (of ?period=week|maand|kwartaal|jaar)
 *
 * Google Ads zoektermen-rapport: verspild budget (zoekopdrachten met uitgaven maar
 * zonder conversie) + best converterende termen. Voor bureau-accountability:
 * direct zien of er geld weglekt aan irrelevante zoekopdrachten.
 *
 * In-memory cache 30 min. Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { getGoogleAdsSearchTerms } from '../../lib/google-ads-spend.js';

export const maxDuration = 60;

const CACHE = new Map();
const TTL_MS = Number(process.env.SEARCH_TERMS_CACHE_MS || 30 * 60 * 1000) || 30 * 60 * 1000;
const ymd = (d) => d.toISOString().slice(0, 10);

function computeRange(period) {
  const now = new Date();
  const days = period === 'week' ? 7 : (period === 'kwartaal' || period === 'quarter') ? 90 : (period === 'jaar' || period === 'year') ? 365 : 30;
  const to = new Date(now);
  const from = new Date(now.getTime() - (days - 1) * 86400000);
  return { from, to };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const period = String(req.query.period || 'maand').toLowerCase();
  const qFrom = String(req.query.from || '').trim();
  const qTo = String(req.query.to || '').trim();
  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());

  const valid = qFrom && qTo && !Number.isNaN(Date.parse(qFrom)) && !Number.isNaN(Date.parse(qTo));
  const range = valid ? { from: new Date(`${qFrom}T00:00:00`), to: new Date(`${qTo}T23:59:59`) } : computeRange(period);

  const cacheKey = `${ymd(range.from)}|${ymd(range.to)}`;
  const hit = CACHE.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.ts < TTL_MS) {
    return res.status(200).json({ ...hit.payload, cached: true });
  }

  const data = await getGoogleAdsSearchTerms({ from: range.from, to: range.to })
    .catch((e) => ({ ok: false, wasted: [], topConverting: [], error: e.message || 'fout' }));

  const payload = { success: true, range: { from: ymd(range.from), to: ymd(range.to) }, ...data };
  CACHE.set(cacheKey, { ts: Date.now(), payload });
  if (CACHE.size > 30) CACHE.delete(CACHE.keys().next().value);
  return res.status(200).json({ ...payload, cached: false });
}
