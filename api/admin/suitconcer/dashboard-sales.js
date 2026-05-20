import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getTransactions } from '../../../lib/srs-customers-client.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';

/**
 * GET /api/admin/suitconcer/dashboard-sales
 *
 * Alleen sales-cijfers voor Suitconcer (branch 702). Wordt apart geladen
 * door het frontend zodat het hoofd-dashboard niet hangt op SRS-calls.
 *
 * Default scope is 'today' (snelste). Frontend kan ?scope=month vragen
 * voor de "deze maand" cijfers (kan trager zijn).
 *
 * Query: ?scope=today | week | month
 */

const VERKOOP = '702';
const CACHE_TTL_MS = Number(process.env.SUITCONCER_SALES_CACHE_MS || 3 * 60 * 1000);
const cache = new Map();

function clean(v) { return String(v || '').trim(); }
function iso(d) { return d.toISOString().slice(0, 19); }

function rangeFor(scope, now = new Date()) {
  const s = clean(scope).toLowerCase() || 'today';
  if (s === 'week') {
    const until = new Date(now);
    const from = new Date(now); from.setDate(from.getDate() - 6); from.setHours(0, 0, 0, 0);
    const prevUntil = new Date(from); prevUntil.setSeconds(prevUntil.getSeconds() - 1);
    const prevFrom = new Date(prevUntil); prevFrom.setDate(prevFrom.getDate() - 6); prevFrom.setHours(0, 0, 0, 0);
    return { from, until, prevFrom, prevUntil };
  }
  if (s === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const until = new Date(now);
    /* Vorige maand voor trend */
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevUntil = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { from, until, prevFrom, prevUntil };
  }
  /* today (default) */
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const until = new Date(now);
  const prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 1);
  const prevUntil = new Date(until); prevUntil.setDate(prevUntil.getDate() - 1);
  return { from, until, prevFrom, prevUntil };
}

function summarize(transactions) {
  let revenue = 0;
  let itemsSold = 0;
  let count = 0;
  const productMap = new Map();
  const orders = [];
  for (const tx of transactions) {
    if (String(tx.branchId || '') !== VERKOOP) continue;
    const total = Number(tx.total || 0);
    revenue += total;
    count += 1;
    const pieces = (tx.items || []).reduce((s, it) => s + Number(it.pieces || 0), 0);
    itemsSold += pieces;
    orders.push({
      orderNr: tx.orderNr || '',
      receiptNr: tx.receiptNr || '',
      dateTime: tx.dateTime || '',
      total: Number(total.toFixed(2)),
      itemCount: pieces,
      lineCount: (tx.items || []).length,
      customerId: tx.customerId || ''
    });
    for (const it of (tx.items || [])) {
      const key = it.sku || it.lineNr;
      if (!key) continue;
      const p = productMap.get(key) || { sku: it.sku || '-', title: it.sku || '-', pieces: 0, revenue: 0 };
      p.pieces += Number(it.pieces || 0);
      p.revenue += Number(it.charged || 0);
      productMap.set(key, p);
    }
  }
  return {
    revenue: Number(revenue.toFixed(2)),
    transactionCount: count,
    itemsSold,
    avgOrderValue: count ? Number((revenue / count).toFixed(2)) : 0,
    topProducts: Array.from(productMap.values()).sort((a, b) => b.pieces - a.pieces).slice(0, 5),
    recentOrders: orders.sort((a, b) => String(b.dateTime).localeCompare(String(a.dateTime))).slice(0, 10)
  };
}

async function safeTx(from, until) {
  try {
    const r = await getTransactions({ from: iso(from), until: iso(until) });
    return { ok: true, transactions: r.transactions || [], error: null };
  } catch (error) {
    return { ok: false, transactions: [], error: error.message };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  if (!(await isFeatureEnabled('suitconcer'))) {
    return res.status(403).json({ success: false, message: 'Suitconcer is uitgeschakeld.' });
  }

  const scope = clean(req.query.scope || 'today').toLowerCase();
  const range = rangeFor(scope);
  const cacheKey = `${scope}|${iso(range.from)}|${iso(range.until)}`;

  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  /* Voor 'today' doen we 1 call (geen vergelijking). Voor 'week' en
     'month' doen we 2 parallel (current + previous voor trend). */
  const calls = scope === 'today'
    ? [safeTx(range.from, range.until)]
    : [safeTx(range.from, range.until), safeTx(range.prevFrom, range.prevUntil)];

  try {
    const results = await Promise.all(calls);
    const curRes = results[0];
    const prevRes = results[1] || { ok: true, transactions: [], error: null };

    const cur = summarize(curRes.transactions);
    const prev = summarize(prevRes.transactions);
    const trendPct = prev.revenue
      ? Number((((cur.revenue - prev.revenue) / prev.revenue) * 100).toFixed(1))
      : null;

    const data = {
      success: true,
      scope,
      branchId: VERKOOP,
      degraded: !curRes.ok,
      errors: !curRes.ok ? [{ source: `srs-${scope}`, message: curRes.error }] : [],
      range: { from: range.from.toISOString(), to: range.until.toISOString() },
      current: cur,
      previous: { revenue: prev.revenue, transactionCount: prev.transactionCount, trendPct }
    };
    if (curRes.ok) cache.set(cacheKey, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (error) {
    console.error('[suitconcer/dashboard-sales] fatal:', error);
    return res.status(200).json({
      success: true,
      scope,
      degraded: true,
      errors: [{ source: 'fatal', message: error.message }],
      current: { revenue: 0, transactionCount: 0, itemsSold: 0, avgOrderValue: 0, topProducts: [], recentOrders: [] },
      previous: { revenue: 0, transactionCount: 0, trendPct: null }
    });
  }
}
