import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getTransactions } from '../../lib/srs-customers-client.js';
import {
  listBranches,
  getStoreNameByBranchId,
  isWarehouseStore
} from '../../lib/branch-metrics.js';

/**
 * GET /api/admin/revenue-srs?period=today|week|month|year
 *
 * SRS-versie van /api/admin/revenue. Gebruikt SRS GetTransactions (SOAP)
 * met alleen een periode-filter -> krijgt ALLE transacties van alle
 * branches in 1 call. Groepeert daarna per branchId -> winkel.
 *
 * SRS is de single source of truth voor omzet:
 *   - Kassa-transacties (winkel)
 *   - Webshop orders (si_weborder route)
 *   - Reserveringen die zijn afgerekend
 *
 * Response (zelfde shape als /admin/revenue):
 *   {
 *     success, period, range: {from, to},
 *     totals: {totalRevenue, orderCount, avgOrderValue, ...},
 *     perStore: [{store, revenue, orderCount}],
 *     topProducts: [{title, sku, quantity, revenue}],
 *     byDay: [{day, revenue, orderCount}],
 *     previous: {totalRevenue, orderCount, trendPct},
 *     source: 'srs'
 *   }
 */

const CACHE_TTL_MS = Number(process.env.REVENUE_SRS_CACHE_MS || 3 * 60 * 1000);
const cache = new Map();

function clean(v) { return String(v || '').trim(); }
function iso(d) { return d.toISOString().slice(0, 19); }

function computeRange(period, now = new Date()) {
  const p = clean(period).toLowerCase() || 'today';
  if (p === 'week') {
    const until = new Date(now);
    const from = new Date(now); from.setDate(from.getDate() - 6); from.setHours(0, 0, 0, 0);
    const prevUntil = new Date(from); prevUntil.setSeconds(prevUntil.getSeconds() - 1);
    const prevFrom = new Date(prevUntil); prevFrom.setDate(prevFrom.getDate() - 6); prevFrom.setHours(0, 0, 0, 0);
    return { from, until, prevFrom, prevUntil };
  }
  if (p === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const until = new Date(now);
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevUntil = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
    return { from, until, prevFrom, prevUntil };
  }
  if (p === 'year') {
    const from = new Date(now.getFullYear(), 0, 1);
    const until = new Date(now);
    const prevFrom = new Date(now.getFullYear() - 1, 0, 1);
    const prevUntil = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
    return { from, until, prevFrom, prevUntil };
  }
  /* today */
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const until = new Date(now);
  const prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 1);
  const prevUntil = new Date(until); prevUntil.setDate(prevUntil.getDate() - 1);
  return { from, until, prevFrom, prevUntil };
}

function aggregate(transactions, storeFilter, branchIdFilter, { excludeWeborders = true } = {}) {
  let totalRevenue = 0;
  let itemsSold = 0;
  let orderCount = 0;
  let skippedWeborders = 0;
  let skippedWeborderRevenue = 0;
  const storeMap = new Map();
  const productMap = new Map();
  const dayMap = new Map();

  for (const tx of transactions) {
    const branchId = String(tx.branchId || '').trim();
    if (branchIdFilter && branchId !== String(branchIdFilter)) continue;

    const storeName = getStoreNameByBranchId(branchId);
    if (storeFilter && storeName !== storeFilter) continue;

    /* Bonnen-filter: transactie moet een receiptNr hebben (=bon afgedrukt
       op kassa). Pure webshop-orders zonder bon (alleen orderNr) worden
       NIET als winkel-omzet geteld — die zijn webshop-omzet. Een webshop-
       order die afgehaald wordt in de winkel heeft WEL een receiptNr en
       telt dus mee. */
    const hasReceipt = Boolean(String(tx.receiptNr || '').trim());
    const hasOrderOnly = Boolean(String(tx.orderNr || '').trim()) && !hasReceipt;
    if (excludeWeborders && hasOrderOnly) {
      skippedWeborders += 1;
      skippedWeborderRevenue += Number(tx.total || 0);
      continue;
    }

    const total = Number(tx.total || 0);
    totalRevenue += total;
    orderCount += 1;

    const cur = storeMap.get(storeName) || { store: storeName, branchId, revenue: 0, orderCount: 0, items: 0 };
    cur.revenue += total;
    cur.orderCount += 1;
    cur.items += (tx.items || []).reduce((s, i) => s + Number(i.pieces || 0), 0);
    storeMap.set(storeName, cur);

    (tx.items || []).forEach((it) => {
      const pieces = Number(it.pieces || 0);
      const charged = Number(it.charged || 0);
      itemsSold += pieces;
      const key = it.sku || it.lineNr || `line-${tx.receiptNr}`;
      const p = productMap.get(key) || { title: it.sku || '-', sku: it.sku || '', quantity: 0, revenue: 0 };
      p.quantity += pieces;
      p.revenue += charged;
      productMap.set(key, p);
    });

    const day = String(tx.dateTime || '').slice(0, 10);
    if (day) {
      const dc = dayMap.get(day) || { day, revenue: 0, orderCount: 0 };
      dc.revenue += total;
      dc.orderCount += 1;
      dayMap.set(day, dc);
    }
  }

  return {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    refundedRevenue: 0,
    netRevenue: Number(totalRevenue.toFixed(2)),
    orderCount,
    avgOrderValue: orderCount ? Number((totalRevenue / orderCount).toFixed(2)) : 0,
    itemsSold,
    /* Diagnostiek: hoeveel weborder-omzet werd uitgesloten (excludeWeborders=true) */
    excludedWeborderCount: skippedWeborders,
    excludedWeborderRevenue: Number(skippedWeborderRevenue.toFixed(2)),
    revenueSourceLabel: 'Bonnen (kassa-transacties, excl. puur web-orders)',
    perStore: [...storeMap.values()]
      .map((s) => ({ ...s, revenue: Number(s.revenue.toFixed(2)) }))
      .sort((a, b) => b.revenue - a.revenue),
    topProducts: [...productMap.values()]
      .map((p) => ({ ...p, revenue: Number(p.revenue.toFixed(2)) }))
      .sort((a, b) => b.quantity - a.quantity)
      .slice(0, 10),
    byDay: [...dayMap.values()]
      .map((d) => ({ ...d, revenue: Number(d.revenue.toFixed(2)) }))
      .sort((a, b) => a.day.localeCompare(b.day))
  };
}

async function fetchPeriod(from, until) {
  const result = await getTransactions({
    from: iso(from),
    until: iso(until)
  });
  return result.transactions || [];
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const period = clean(req.query.period || 'today').toLowerCase();
  const storeFilter = clean(req.query.store);
  const branchIdFilter = clean(req.query.branchId);
  const customFrom = clean(req.query.dateFrom || req.query.from);
  const customTo = clean(req.query.dateTo || req.query.to);

  let range = computeRange(period);
  if (customFrom) {
    const from = new Date(customFrom);
    const to = customTo ? new Date(customTo) : new Date();
    if (!Number.isNaN(from.getTime())) {
      from.setHours(0, 0, 0, 0);
      if (!Number.isNaN(to.getTime())) to.setHours(23, 59, 59, 999);
      const periodMs = to.getTime() - from.getTime();
      const prevUntil = new Date(from); prevUntil.setSeconds(prevUntil.getSeconds() - 1);
      const prevFrom = new Date(from.getTime() - periodMs);
      range = { from, until: to, prevFrom, prevUntil };
    }
  }

  /* Default: alleen bonnen (kassa-transacties). Met ?includeWeborders=1
     krijgt admin alle SRS-transacties incl. puur web-orders. */
  const includeWeborders = String(req.query.includeWeborders || '') === '1';
  const excludeWeborders = !includeWeborders;

  const cacheKey = `${period}|${iso(range.from)}|${iso(range.until)}|${storeFilter}|${branchIdFilter}|excl=${excludeWeborders}`;
  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    const [current, previous] = await Promise.all([
      fetchPeriod(range.from, range.until),
      fetchPeriod(range.prevFrom, range.prevUntil)
    ]);

    const cur = aggregate(current, storeFilter, branchIdFilter, { excludeWeborders });
    const prev = aggregate(previous, storeFilter, branchIdFilter, { excludeWeborders });
    const trendPct = prev.totalRevenue
      ? Number((((cur.totalRevenue - prev.totalRevenue) / prev.totalRevenue) * 100).toFixed(1))
      : null;

    /* Voeg ook 0-omzet winkels toe aan perStore zodat admin ziet welke
       winkels niet hebben verkocht (handig voor monitoring). */
    const branches = listBranches({ includeInternal: false });
    const existingStores = new Set(cur.perStore.map((s) => s.store));
    for (const b of branches) {
      if (!existingStores.has(b.store) && !isWarehouseStore(b.store)) {
        cur.perStore.push({
          store: b.store,
          branchId: b.branchId,
          revenue: 0,
          orderCount: 0,
          items: 0
        });
      }
    }
    cur.perStore.sort((a, b) => b.revenue - a.revenue);

    const data = {
      success: true,
      source: 'srs',
      period,
      range: { from: range.from.toISOString(), to: range.until.toISOString() },
      configured: true,
      totals: cur,
      previous: {
        totalRevenue: prev.totalRevenue,
        orderCount: prev.orderCount,
        trendPct
      },
      perStore: cur.perStore,
      topProducts: cur.topProducts,
      byDay: cur.byDay,
      transactionCount: current.length,
      transactionCountPrev: previous.length
    };

    cache.set(cacheKey, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (error) {
    console.error('[revenue-srs] error:', error);
    return res.status(200).json({
      success: true,
      source: 'srs',
      period,
      configured: true,
      degraded: true,
      message: error.message || 'SRS GetTransactions faalde.',
      totals: { totalRevenue: 0, orderCount: 0, avgOrderValue: 0, refundedRevenue: 0, netRevenue: 0, perStore: [], topProducts: [], byDay: [] },
      previous: { totalRevenue: 0, orderCount: 0, trendPct: null },
      perStore: [],
      topProducts: [],
      byDay: []
    });
  }
}
