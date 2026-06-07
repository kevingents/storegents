/**
 * /api/admin/marketing-poas
 *
 * Winstgevendheid + POAS van de webshop (online) voor het Marketing-dashboard.
 *   GET ?period=today|week|month|year  (of ?from=&to=)  → geselecteerde periode
 *   GET ?refresh=1                                      → cache omzeilen
 *
 * Levert: netto-omzet, COGS, brutowinst, marge%, retouren, ad spend (Google Ads),
 * POAS, ROAS, break-even-ROAS, COGS-dekking, top-producten-op-winst + 6-maands
 * trend. Cache 1u (zware Shopify/Ads-calls). Faalt graceful: ontbrekende Google
 * Ads → spend null + nette melding, omzet/marge blijft staan.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { computePoasForRange } from '../../lib/poas-compute.js';
import { getGoogleAdsCampaigns } from '../../lib/google-ads-spend.js';
import { getMetaAdsSpend } from '../../lib/meta-ads-spend.js';
import { readPortalConfig, savePortalConfig, marketingTargets } from '../../lib/portal-config-store.js';
import { readJsonBlob, writeJsonBlob } from '../../lib/json-blob-store.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export const maxDuration = 120;
const CACHE_PATH = 'marketing/poas-cache.json';
const CACHE_MS = 60 * 60 * 1000;
const r2 = (n) => (n == null ? null : Math.round((Number(n) || 0) * 100) / 100);

function computeRange(period, customFrom, customTo) {
  const now = new Date();
  if (customFrom) {
    const from = new Date(customFrom);
    const to = customTo ? new Date(customTo) : new Date(now);
    if (!Number.isNaN(from.getTime())) { from.setHours(0, 0, 0, 0); if (!Number.isNaN(to.getTime())) to.setHours(23, 59, 59, 999); return { from, to }; }
  }
  const to = new Date(now);
  const from = new Date(now);
  if (period === 'week') { from.setDate(from.getDate() - 7); from.setHours(0, 0, 0, 0); }
  else if (period === 'month') { from.setDate(from.getDate() - 30); from.setHours(0, 0, 0, 0); }
  else if (period === 'year') { from.setFullYear(from.getFullYear() - 1); from.setHours(0, 0, 0, 0); }
  else { from.setHours(0, 0, 0, 0); }
  return { from, to };
}

function lastMonthRanges(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const from = new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
    const to = (i === 0) ? now : new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
    out.push({ label: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, from, to });
  }
  return out;
}

async function poasForRange(from, to) {
  const [fin, g, m] = await Promise.all([
    computePoasForRange({ from, to }),
    getGoogleAdsCampaigns({ from, to }),
    getMetaAdsSpend({ from, to })
  ]);
  /* Online ad spend = Shopping-advertenties + Meta. Winkel-advertenties (de stad-
     campagnes) sturen de FYSIEKE winkels aan en tellen NIET mee in de online
     POAS/ROAS — die hebben hun eigen ROAS op het Winkel-dashboard. */
  const googleShoppingSpend = g.ok ? (g.splits?.shopping?.spend || 0) : null;
  const googleWinkelSpend = g.ok ? (g.splits?.winkel?.spend || 0) : null;
  const metaSpend = m.ok ? m.spend : null;
  const adSpend = (g.ok || m.ok) ? r2((googleShoppingSpend || 0) + (metaSpend || 0)) : null;
  const usable = adSpend && adSpend > 0;
  const errors = [!g.ok && g.error, !m.ok && m.error].filter(Boolean);
  return {
    ...fin,
    adSpend,
    googleSpend: googleShoppingSpend, /* online = Shopping-spend */
    googleShoppingSpend, googleWinkelSpend, metaSpend,
    googleOk: g.ok, metaOk: m.ok,
    adSpendOk: g.ok || m.ok,
    adSpendError: errors.length ? errors.join(' · ') : null,
    poas: (usable && fin.brutowinst != null) ? r2(fin.brutowinst / adSpend) : null,
    roas: (usable && fin.nettoOmzetIncl != null) ? r2(fin.nettoOmzetIncl / adSpend) : null
  };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  /* Maandtargets opslaan. */
  if (req.method === 'POST') {
    const b = parseBody(req);
    if (b.saveTargets && typeof b.saveTargets === 'object') {
      try {
        await savePortalConfig({ marketing: b.saveTargets }, 'marketing-admin');
        return res.status(200).json({ success: true, targets: marketingTargets(await readPortalConfig()) });
      } catch (e) { return res.status(500).json({ success: false, message: e.message || 'Opslaan mislukt.' }); }
    }
    return res.status(400).json({ success: false, message: 'Onbekende POST.' });
  }

  const period = String(req.query.period || 'month').toLowerCase();
  const from = String(req.query.from || req.query.dateFrom || '').trim();
  const to = String(req.query.to || req.query.dateTo || '').trim();
  const refresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
  const cacheKey = `${period}|${from}|${to}`;

  try {
    if (!refresh) {
      const cache = await readJsonBlob(CACHE_PATH, null).catch(() => null);
      if (cache && cache.key === cacheKey && cache.at && (Date.now() - new Date(cache.at).getTime()) < CACHE_MS) {
        return res.status(200).json({ ...cache.data, cached: true, cachedAt: cache.at });
      }
    }

    const range = computeRange(period, from, to);
    const current = await poasForRange(range.from, range.to);

    let trend = [];
    if (current.configured !== false) {
      const months = lastMonthRanges(6);
      trend = (await Promise.all(months.map(async (m) => {
        try {
          const p = await poasForRange(m.from, m.to);
          return { label: m.label, nettoOmzetIncl: p.nettoOmzetIncl, nettoOmzetEx: p.nettoOmzetEx, brutowinst: p.brutowinst, margePct: p.margePct, adSpend: p.adSpend, poas: p.poas, roas: p.roas };
        } catch { return { label: m.label, error: true }; }
      })));
    }

    const data = {
      success: true,
      period,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      configured: current.configured !== false,
      current,
      trend,
      targets: marketingTargets(await readPortalConfig().catch(() => ({})))
    };
    try { await writeJsonBlob(CACHE_PATH, { key: cacheKey, at: new Date().toISOString(), data }); } catch (_) {}
    return res.status(200).json({ ...data, cached: false });
  } catch (error) {
    console.error('[admin/marketing-poas]', error);
    return res.status(200).json({ success: true, configured: false, message: error.message || 'POAS-berekening mislukte.', current: {}, trend: [] });
  }
}
