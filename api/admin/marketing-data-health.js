/**
 * GET /api/admin/marketing-data-health
 *
 * Statusoverzicht van alle databronnen die het marketing-dashboard voeden:
 * GA4, Google Ads (live geprobed), Meta, Shopify, Spotler, SRS en Claude
 * (op env-aanwezigheid). Per bron: ok / warn / off + uitleg.
 *
 * In-memory cache 10 min (de live probes kosten een paar seconden). Auth: admin-token.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { probeGa4 } from '../../lib/ga4-client.js';
import { probeGoogleAds } from '../../lib/google-ads-client.js';

export const maxDuration = 60;

const CACHE = { ts: 0, payload: null };
const TTL_MS = 10 * 60 * 1000;
const clean = (v) => String(v == null ? '' : v).trim();
const hasPrefix = (p) => Object.keys(process.env).some((k) => k.startsWith(p) && clean(process.env[k]));

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
  if (!refresh && CACHE.payload && Date.now() - CACHE.ts < TTL_MS) {
    return res.status(200).json({ ...CACHE.payload, cached: true });
  }

  const [ga4, ads] = await Promise.all([
    probeGa4().catch((e) => ({ oauth: { ok: false }, ga4: {}, diagnosis: e.message || 'GA4-fout' })),
    probeGoogleAds().catch((e) => ({ oauth: { ok: false }, ads: {}, diagnosis: e.message || 'Ads-fout' }))
  ]);

  const ga4Status = ga4?.ga4?.ok ? 'ok' : (ga4?.oauth?.ok ? 'warn' : 'off');
  const adsStatus = ads?.ads?.ok ? 'ok' : (ads?.oauth?.ok ? 'warn' : 'off');
  const meta = hasPrefix('META_') || hasPrefix('FACEBOOK_');
  const shopify = hasPrefix('SHOPIFY_');
  const spotler = hasPrefix('SPOTLER_');
  const srs = hasPrefix('SRS_');
  const claude = !!(clean(process.env.CLAUDE_API_KEY) || clean(process.env.ANTHROPIC_API_KEY));

  const sources = [
    { key: 'ga4', label: 'Google Analytics (GA4)', status: ga4Status, detail: ga4?.diagnosis || '' },
    { key: 'ads', label: 'Google Ads', status: adsStatus, detail: ads?.diagnosis || '' },
    { key: 'meta', label: 'Meta Ads', status: meta ? 'ok' : 'off', detail: meta ? 'Gekoppeld' : 'Niet gekoppeld' },
    { key: 'shopify', label: 'Shopify (webshop)', status: shopify ? 'ok' : 'off', detail: shopify ? 'Gekoppeld' : 'Niet gekoppeld' },
    { key: 'spotler', label: 'Spotler (e-mail)', status: spotler ? 'ok' : 'off', detail: spotler ? 'Gekoppeld' : 'Niet gekoppeld' },
    { key: 'srs', label: 'SRS ERP', status: srs ? 'ok' : 'off', detail: srs ? 'Gekoppeld' : 'Niet gekoppeld' },
    { key: 'claude', label: 'AI (Claude)', status: claude ? 'ok' : 'off', detail: claude ? 'Gekoppeld' : 'Niet gekoppeld' }
  ];

  const payload = {
    success: true,
    okCount: sources.filter((s) => s.status === 'ok').length,
    total: sources.length,
    sources,
    generatedAt: new Date().toISOString()
  };
  CACHE.ts = Date.now();
  CACHE.payload = payload;
  return res.status(200).json({ ...payload, cached: false });
}
