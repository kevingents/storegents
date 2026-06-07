/**
 * GET /api/admin/marketing-mer?from=YYYY-MM-DD&to=YYYY-MM-DD  (of ?period=...)
 *
 * MER (Marketing Efficiency Ratio) = totale omzet (webshop online + winkel kassa)
 * ÷ totale marketing-spend (Google Shopping + winkel-ads + Meta). De noord-ster
 * voor een retailer met webshop én fysieke winkels — POAS/ROAS zijn deelmetrieken.
 * Inclusief vorige even lange periode voor de trend (Δ%). 30min cache.
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { computePoasForRange } from '../../lib/poas-compute.js';
import { getGoogleAdsCampaigns } from '../../lib/google-ads-spend.js';
import { getMetaAdsSpend } from '../../lib/meta-ads-spend.js';
import { readLedger, aggregateLedger } from '../../lib/srs-retail-ledger.js';

export const maxDuration = 60;

const CACHE = new Map();
const TTL_MS = 30 * 60 * 1000;
const ymd = (d) => d.toISOString().slice(0, 10);
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function computeRange(period) {
  const now = new Date();
  const days = period === 'week' ? 7 : (period === 'kwartaal' || period === 'quarter') ? 90 : (period === 'jaar' || period === 'year') ? 365 : 30;
  const to = new Date(now);
  const from = new Date(now.getTime() - (days - 1) * 86400000);
  return { from, to };
}

async function gather(from, to, ledger) {
  const [fin, g, m] = await Promise.all([
    computePoasForRange({ from, to }).catch(() => ({})),
    getGoogleAdsCampaigns({ from, to }).catch(() => ({ ok: false })),
    getMetaAdsSpend({ from, to }).catch(() => ({ ok: false }))
  ]);
  const onlineOmzet = r2(fin.nettoOmzetIncl || 0);
  let offlineOmzet = 0;
  try { offlineOmzet = r2(aggregateLedger(ledger, { from: ymd(from), to: ymd(to) }).totals.omzet || 0); } catch (_) {}
  const shoppingSpend = g.ok ? r2(g.splits?.shopping?.spend || 0) : 0;
  const winkelSpend = g.ok ? r2(g.splits?.winkel?.spend || 0) : 0;
  const metaSpend = m.ok ? r2(m.spend || 0) : 0;
  const totalSpend = r2(shoppingSpend + winkelSpend + metaSpend);
  const totalOmzet = r2(onlineOmzet + offlineOmzet);
  return {
    onlineOmzet, offlineOmzet, totalOmzet,
    shoppingSpend, winkelSpend, metaSpend, totalSpend,
    mer: totalSpend > 0 ? r2(totalOmzet / totalSpend) : null,
    googleOk: g.ok, metaOk: m.ok
  };
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
  const cur = valid ? { from: new Date(`${qFrom}T00:00:00`), to: new Date(`${qTo}T23:59:59`) } : computeRange(period);
  const days = Math.max(1, Math.round((cur.to - cur.from) / 86400000) + 1);
  const prevTo = new Date(cur.from.getTime() - 86400000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86400000);

  const cacheKey = `${ymd(cur.from)}|${ymd(cur.to)}`;
  const hit = CACHE.get(cacheKey);
  if (!refresh && hit && Date.now() - hit.ts < TTL_MS) return res.status(200).json({ ...hit.payload, cached: true });

  try {
    const ledger = await readLedger().catch(() => ({ stores: {} }));
    const [current, previous] = await Promise.all([
      gather(cur.from, cur.to, ledger),
      gather(prevFrom, prevTo, ledger)
    ]);
    const delta = (a, b) => (b > 0 ? r2(((a - b) / b) * 100) : null);
    const payload = {
      success: true,
      range: { from: ymd(cur.from), to: ymd(cur.to) },
      current,
      previous,
      deltas: {
        mer: (current.mer != null && previous.mer != null && previous.mer > 0) ? delta(current.mer, previous.mer) : null,
        omzet: delta(current.totalOmzet, previous.totalOmzet),
        spend: delta(current.totalSpend, previous.totalSpend)
      }
    };
    CACHE.set(cacheKey, { ts: Date.now(), payload });
    if (CACHE.size > 20) CACHE.delete(CACHE.keys().next().value);
    return res.status(200).json({ ...payload, cached: false });
  } catch (e) {
    console.error('[admin/marketing-mer]', e);
    return res.status(200).json({ success: false, message: e.message || 'MER berekenen mislukt.' });
  }
}
