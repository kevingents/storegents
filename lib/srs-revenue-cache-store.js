/**
 * SRS revenue cache per branch.
 *
 * Cron pre-aggregeert SRS GetTransactions in dagelijkse buckets per branchId.
 * Dashboard reads gebeuren dan tegen deze cache (< 100ms ipv 60+ seconden).
 *
 * Blob layout:
 *   srs-revenue-cache/index.json
 *     { branchIds: [...], generatedAt, lastFullRefreshAt }
 *
 *   srs-revenue-cache/branch-<branchId>.json
 *     {
 *       branchId,
 *       updatedAt,
 *       days: {
 *         "2026-05-20": { revenue, transactionCount, itemsSold, topSkus: [{sku, pieces, revenue}], orders: [{...}] },
 *         "2026-05-19": { ... },
 *         ...
 *       }
 *     }
 *
 * Days die ouder zijn dan 90 dagen worden weggegooid om grootte te beperken.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const INDEX_PATH = 'srs-revenue-cache/index.json';
const BRANCH_PATH_PREFIX = 'srs-revenue-cache/branch-';
const MAX_DAYS_KEEP = Number(process.env.REVENUE_CACHE_MAX_DAYS || 90);
const MAX_ORDERS_PER_DAY = 50; /* recent-orders limit voor dashboard */
const MAX_SKUS_PER_DAY = 20;   /* top-products limit per dag */

function branchPath(branchId) {
  const clean = String(branchId || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!clean) throw new Error('branchPath: ongeldig branchId.');
  return `${BRANCH_PATH_PREFIX}${clean}.json`;
}

function clampDays(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - MAX_DAYS_KEEP);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  const result = {};
  for (const [day, val] of Object.entries(days || {})) {
    if (day >= cutoffStr) result[day] = val;
  }
  return result;
}

export async function readBranchRevenue(branchId) {
  if (!branchId) return null;
  return readJsonBlob(branchPath(branchId), {
    branchId: String(branchId),
    updatedAt: null,
    days: {}
  });
}

export async function writeBranchRevenue(branchId, dayMap) {
  const clean = String(branchId || '');
  if (!clean) throw new Error('branchId ontbreekt.');
  const payload = {
    branchId: clean,
    updatedAt: new Date().toISOString(),
    days: clampDays(dayMap || {})
  };
  await writeJsonBlob(branchPath(clean), payload);
  return payload;
}

export async function mergeBranchRevenue(branchId, newDays) {
  const existing = await readBranchRevenue(branchId);
  const merged = { ...(existing?.days || {}) };
  for (const [day, data] of Object.entries(newDays || {})) {
    merged[day] = data; /* nieuwste wint */
  }
  return writeBranchRevenue(branchId, merged);
}

export async function readRevenueIndex() {
  return readJsonBlob(INDEX_PATH, {
    branchIds: [],
    generatedAt: null,
    lastFullRefreshAt: null
  });
}

export async function writeRevenueIndex(idx) {
  await writeJsonBlob(INDEX_PATH, {
    ...idx,
    generatedAt: new Date().toISOString()
  });
  return idx;
}

/**
 * Bouw aggregaat voor een specifieke periode (today/week/month/year) uit
 * de gecachte dagelijkse data van 1 branch.
 *
 * Returnt { revenue, transactionCount, itemsSold, avgOrderValue, topProducts, recentOrders }
 */
export async function aggregateBranchForPeriod(branchId, period = 'today', now = new Date()) {
  const data = await readBranchRevenue(branchId);
  if (!data || !data.days) {
    return {
      revenue: 0,
      transactionCount: 0,
      itemsSold: 0,
      avgOrderValue: 0,
      topProducts: [],
      recentOrders: [],
      fromCache: false,
      cacheAge: null
    };
  }

  const p = String(period || 'today').toLowerCase();
  const todayStr = now.toISOString().slice(0, 10);
  let fromDay;
  if (p === 'today') fromDay = todayStr;
  else if (p === 'week') {
    const d = new Date(now); d.setDate(d.getDate() - 6);
    fromDay = d.toISOString().slice(0, 10);
  } else if (p === 'month') {
    const d = new Date(now.getFullYear(), now.getMonth(), 1);
    fromDay = d.toISOString().slice(0, 10);
  } else if (p === 'year') {
    const d = new Date(now.getFullYear(), 0, 1);
    fromDay = d.toISOString().slice(0, 10);
  } else {
    fromDay = todayStr;
  }

  let revenue = 0;
  let count = 0;
  let itemsSold = 0;
  const productMap = new Map();
  const orders = [];

  for (const [day, info] of Object.entries(data.days)) {
    if (day < fromDay || day > todayStr) continue;
    revenue += Number(info.revenue || 0);
    count += Number(info.transactionCount || 0);
    itemsSold += Number(info.itemsSold || 0);

    for (const sku of (info.topSkus || [])) {
      const k = sku.sku || sku.title;
      if (!k) continue;
      const e = productMap.get(k) || { sku: sku.sku || '-', title: sku.title || sku.sku || '-', pieces: 0, revenue: 0 };
      e.pieces += Number(sku.pieces || 0);
      e.revenue += Number(sku.revenue || 0);
      productMap.set(k, e);
    }
    for (const o of (info.orders || [])) {
      orders.push(o);
    }
  }

  return {
    revenue: Number(revenue.toFixed(2)),
    transactionCount: count,
    itemsSold,
    avgOrderValue: count ? Number((revenue / count).toFixed(2)) : 0,
    topProducts: Array.from(productMap.values())
      .map((p) => ({ ...p, revenue: Number(p.revenue.toFixed(2)) }))
      .sort((a, b) => b.pieces - a.pieces)
      .slice(0, 10),
    recentOrders: orders
      .sort((a, b) => String(b.dateTime).localeCompare(String(a.dateTime)))
      .slice(0, 20),
    fromCache: true,
    cacheAge: data.updatedAt ? Math.round((Date.now() - new Date(data.updatedAt).getTime()) / 1000) : null
  };
}
