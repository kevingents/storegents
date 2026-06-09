import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  readRevenueIndex,
  readBranchRevenue
} from '../../lib/srs-revenue-cache-store.js';
import {
  getStoreNameByBranchId,
  isWarehouseStore
} from '../../lib/branch-metrics.js';

/**
 * GET /api/admin/revenue-srs-cached?period=today|week|month|year[&store=|&branchId=]
 *
 * Cache-backed variant van /api/admin/revenue-srs. Leest de SRS-omzet uit de
 * per-branch/per-dag dagcache (gevuld door cron /api/cron/srs-revenue-cache)
 * i.p.v. live SOAP. Daardoor werkt het WEL voor week/maand/jaar (live SOAP
 * loopt daar in een 45s-timeout).
 *
 * SINGLE SOURCE: alle omzet komt uit SRS, per branch. De webshop is gewoon
 * branch 90 ("GENTS Webshop") en verschijnt als eigen winkel-rij. Magazijn/
 * interne branches worden uitgesloten (behalve webshop 90).
 *
 * Response (compatibel met revenue-srs):
 *   { success, source:'srs-cache', period, range:{from,to},
 *     totals:{ totalRevenue, netRevenue, orderCount, itemsSold, avgOrderValue,
 *              perStore:[{store,branchId,revenue,orderCount,items}], topProducts, byDay },
 *     previous:{ totalRevenue, orderCount, trendPct },
 *     perStore, topProducts, byDay, cacheUpdatedAt, degraded? }
 */

const WEBSHOP_BRANCH = '90';

function clean(v) { return String(v || '').trim(); }
function dayStr(d) { return d.toISOString().slice(0, 10); }

/* Periode → dag-range (strings) voor huidige + vorige periode. Spiegelt de
   logica van revenue-srs.computeRange maar dan op dag-granulariteit. */
function computeRange(period, now = new Date()) {
  const p = clean(period).toLowerCase() || 'today';
  const today = dayStr(now);
  if (p === 'week') {
    const from = new Date(now); from.setDate(from.getDate() - 6);
    const prevTo = new Date(from); prevTo.setDate(prevTo.getDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setDate(prevFrom.getDate() - 6);
    return { from: dayStr(from), to: today, prevFrom: dayStr(prevFrom), prevTo: dayStr(prevTo) };
  }
  if (p === 'month') {
    const from = new Date(now.getFullYear(), now.getMonth(), 1);
    const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevTo = new Date(now.getFullYear(), now.getMonth(), 0);
    return { from: dayStr(from), to: today, prevFrom: dayStr(prevFrom), prevTo: dayStr(prevTo) };
  }
  if (p === 'year') {
    const from = new Date(now.getFullYear(), 0, 1);
    const prevFrom = new Date(now.getFullYear() - 1, 0, 1);
    const prevTo = new Date(now.getFullYear() - 1, 11, 31);
    return { from: dayStr(from), to: today, prevFrom: dayStr(prevFrom), prevTo: dayStr(prevTo) };
  }
  /* today */
  const y = new Date(now); y.setDate(y.getDate() - 1);
  return { from: today, to: today, prevFrom: dayStr(y), prevTo: dayStr(y) };
}

/* Hoort deze branch in de omzet-weergave? Fysieke winkels ja, magazijn/intern
   nee — behalve de webshop (branch 90), die tonen we juist wél als winkel-rij. */
function includeBranch(branchId, storeName) {
  if (String(branchId) === WEBSHOP_BRANCH) return true;
  if (!storeName) return false;
  return !isWarehouseStore(storeName);
}

/* Sommeer de gecachte dagen van één branch over [fromDay, toDay]. */
function sumBranchDays(branch, fromDay, toDay) {
  let revenue = 0;
  let count = 0;
  let items = 0;
  const byDay = new Map();
  const products = new Map();
  for (const [day, info] of Object.entries(branch?.days || {})) {
    if (day < fromDay || day > toDay) continue;
    const dayRevenue = Number(info.revenue || 0);
    revenue += dayRevenue;
    count += Number(info.transactionCount || 0);
    items += Number(info.itemsSold || 0);
    byDay.set(day, (byDay.get(day) || 0) + dayRevenue);
    for (const sku of (info.topSkus || [])) {
      const key = sku.sku || sku.title;
      if (!key) continue;
      const e = products.get(key) || { sku: sku.sku || '-', title: sku.title || sku.sku || '-', quantity: 0, revenue: 0 };
      e.quantity += Number(sku.pieces || 0);
      e.revenue += Number(sku.revenue || 0);
      products.set(key, e);
    }
  }
  return { revenue, count, items, byDay, products };
}

export const maxDuration = 30;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const period = clean(req.query.period || 'today').toLowerCase();
  const storeFilter = clean(req.query.store);
  const branchIdFilter = clean(req.query.branchId);
  const range = computeRange(period);

  try {
    const index = await readRevenueIndex();
    let branchIds = Array.isArray(index?.branchIds) ? index.branchIds.map(String) : [];

    /* Scope: expliciete branchId, of winkelnaam → branchId (werkt ook voor
       "GENTS Webshop" → 90, omdat we matchen op getStoreNameByBranchId). */
    if (branchIdFilter) {
      branchIds = [branchIdFilter];
    } else if (storeFilter) {
      const match = branchIds.filter((bid) => getStoreNameByBranchId(bid) === storeFilter);
      branchIds = match.length ? match : [];
    }

    const perStore = [];
    let totalRevenue = 0;
    let totalCount = 0;
    let totalItems = 0;
    let prevRevenue = 0;
    let prevCount = 0;
    const byDayTotal = new Map();
    const productsTotal = new Map();
    let oldestCacheUpdatedAt = null;

    for (const branchId of branchIds) {
      const storeName = getStoreNameByBranchId(branchId);
      /* Bij expliciete scope (branchId/store) niets uitsluiten; anders filteren. */
      if (!branchIdFilter && !storeFilter && !includeBranch(branchId, storeName)) continue;

      const branch = await readBranchRevenue(branchId);
      if (!branch) continue;
      if (branch.updatedAt) {
        if (!oldestCacheUpdatedAt || branch.updatedAt < oldestCacheUpdatedAt) {
          oldestCacheUpdatedAt = branch.updatedAt;
        }
      }

      const cur = sumBranchDays(branch, range.from, range.to);
      const prev = sumBranchDays(branch, range.prevFrom, range.prevTo);

      prevRevenue += prev.revenue;
      prevCount += prev.count;

      /* Lege branches (geen omzet in beide periodes) overslaan. */
      if (cur.revenue === 0 && cur.count === 0 && prev.revenue === 0) continue;

      perStore.push({
        store: storeName,
        branchId: String(branchId),
        revenue: Number(cur.revenue.toFixed(2)),
        orderCount: cur.count,
        items: cur.items
      });

      totalRevenue += cur.revenue;
      totalCount += cur.count;
      totalItems += cur.items;
      for (const [day, rev] of cur.byDay.entries()) {
        byDayTotal.set(day, (byDayTotal.get(day) || 0) + rev);
      }
      for (const [key, p] of cur.products.entries()) {
        const e = productsTotal.get(key) || { sku: p.sku, title: p.title, quantity: 0, revenue: 0 };
        e.quantity += p.quantity;
        e.revenue += p.revenue;
        productsTotal.set(key, e);
      }
    }

    perStore.sort((a, b) => b.revenue - a.revenue);
    const netRevenue = Number(totalRevenue.toFixed(2));
    const trendPct = prevRevenue
      ? Number((((totalRevenue - prevRevenue) / prevRevenue) * 100).toFixed(1))
      : null;

    const totals = {
      totalRevenue: netRevenue,
      netRevenue,
      grossRevenue: netRevenue,
      refundedRevenue: 0,
      orderCount: totalCount,
      avgOrderValue: totalCount ? Number((netRevenue / totalCount).toFixed(2)) : 0,
      itemsSold: totalItems,
      perStore,
      topProducts: [...productsTotal.values()]
        .map((p) => ({ ...p, revenue: Number(p.revenue.toFixed(2)) }))
        .sort((a, b) => b.quantity - a.quantity)
        .slice(0, 10),
      byDay: [...byDayTotal.entries()]
        .map(([day, revenue]) => ({ day, revenue: Number(revenue.toFixed(2)), orderCount: 0 }))
        .sort((a, b) => a.day.localeCompare(b.day))
    };

    /* Cache nog niet (volledig) gevuld? Markeer degraded zodat de UI dat kan
       tonen i.p.v. stilletjes €0. */
    const cacheEmpty = branchIds.length === 0 || (!oldestCacheUpdatedAt && totalCount === 0);

    return res.status(200).json({
      success: true,
      source: 'srs-cache',
      period,
      configured: true,
      degraded: cacheEmpty || undefined,
      message: cacheEmpty
        ? 'SRS-omzetcache is nog niet gevuld — draai /api/cron/srs-revenue-cache.'
        : undefined,
      range: { from: range.from, to: range.to },
      totals,
      previous: {
        totalRevenue: Number(prevRevenue.toFixed(2)),
        orderCount: prevCount,
        trendPct
      },
      perStore: totals.perStore,
      topProducts: totals.topProducts,
      byDay: totals.byDay,
      cacheUpdatedAt: oldestCacheUpdatedAt
    });
  } catch (error) {
    console.error('[revenue-srs-cached] error:', error);
    return res.status(200).json({
      success: true,
      source: 'srs-cache',
      period,
      configured: true,
      degraded: true,
      message: error.message || 'SRS-omzetcache lezen faalde.',
      totals: { totalRevenue: 0, netRevenue: 0, orderCount: 0, avgOrderValue: 0, refundedRevenue: 0, itemsSold: 0, perStore: [], topProducts: [], byDay: [] },
      previous: { totalRevenue: 0, orderCount: 0, trendPct: null },
      perStore: [],
      topProducts: [],
      byDay: []
    });
  }
}
