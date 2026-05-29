import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getTransactions } from '../../lib/srs-customers-client.js';
import { listAllBranches } from '../../lib/branch-metrics.js';
import {
  readBranchRevenue,
  mergeBranchRevenue,
  readRevenueIndex,
  writeRevenueIndex
} from '../../lib/srs-revenue-cache-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

/**
 * SRS revenue cache cron.
 *
 * Doel: pre-aggregeer SRS GetTransactions data zodat dashboards
 * niet bij elke request 60+ seconden hoeven te wachten.
 *
 * Strategie: per dag (geen volledige periode in 1 call) ophalen vanaf
 * "X dagen geleden". Een dag is doorgaans ~2000-4000 transacties → snel.
 * 30 dagen × ~2 sec/call = ~60 sec totaal voor de hele backlog.
 *
 * Per dag aggregeren we per branchId:
 *   - revenue, transactionCount, itemsSold
 *   - top SKUs (per dag, max 20)
 *   - laatste orders (max 50, met basic info)
 *
 * Schedule (vercel.json): elke 2 uur op de 30e minuut.
 *   "30 [SLASH]2 * * *" — genoeg om dashboard fris te houden.
 *
 * Query options:
 *   ?days=30   aantal dagen terug op te halen (default 30, max 90)
 *   ?branchId= alleen 1 branch verversen (sneller voor on-demand refresh)
 *   ?dry=1     log + return, niets opslaan
 */

const MAX_DAYS = 90;
const DEFAULT_DAYS = Number(process.env.REVENUE_CACHE_DEFAULT_DAYS || 30);
const ITEMS_PER_DAY_LIMIT = 20;
const ORDERS_PER_DAY_LIMIT = 50;

function clean(v) { return String(v || '').trim(); }
function iso(d) { return d.toISOString().slice(0, 19); }
function isoDay(d) { return d.toISOString().slice(0, 10); }

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const givenAdmin = String(
    req.headers['x-admin-token'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  if (adminToken && givenAdmin && adminToken === givenAdmin) return true;

  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const givenCron = String(req.query.secret || req.headers.authorization || '')
    .replace(/^Bearer\s+/i, '').trim();
  return Boolean(cronSecret && givenCron && cronSecret === givenCron);
}

function aggregateDayForBranches(transactions) {
  /* Returns Map<branchId, { revenue, count, itemsSold, topSkus, orders }> */
  const byBranch = new Map();
  for (const tx of transactions) {
    const bid = String(tx.branchId || '');
    if (!bid) continue;
    const cur = byBranch.get(bid) || {
      revenue: 0,
      transactionCount: 0,
      itemsSold: 0,
      _productMap: new Map(),
      orders: []
    };
    const total = Number(tx.total || 0);
    const pieces = (tx.items || []).reduce((s, i) => s + Number(i.pieces || 0), 0);
    cur.revenue += total;
    cur.transactionCount += 1;
    cur.itemsSold += pieces;
    cur.orders.push({
      orderNr: tx.orderNr || '',
      receiptNr: tx.receiptNr || '',
      dateTime: tx.dateTime || '',
      total: Number(total.toFixed(2)),
      itemCount: pieces,
      lineCount: (tx.items || []).length,
      customerId: tx.customerId || ''
    });
    for (const it of (tx.items || [])) {
      const key = it.sku || it.lineNr || `line-${tx.receiptNr}`;
      const p = cur._productMap.get(key) || { sku: it.sku || '-', title: it.sku || '-', pieces: 0, revenue: 0 };
      p.pieces += Number(it.pieces || 0);
      p.revenue += Number(it.charged || 0);
      cur._productMap.set(key, p);
    }
    byBranch.set(bid, cur);
  }

  /* Convert _productMap -> topSkus array, sort orders, finalize */
  const result = new Map();
  for (const [bid, info] of byBranch.entries()) {
    const topSkus = Array.from(info._productMap.values())
      .map((p) => ({ ...p, revenue: Number(p.revenue.toFixed(2)) }))
      .sort((a, b) => b.pieces - a.pieces)
      .slice(0, ITEMS_PER_DAY_LIMIT);
    const orders = info.orders
      .sort((a, b) => String(b.dateTime).localeCompare(String(a.dateTime)))
      .slice(0, ORDERS_PER_DAY_LIMIT);
    result.set(bid, {
      revenue: Number(info.revenue.toFixed(2)),
      transactionCount: info.transactionCount,
      itemsSold: info.itemsSold,
      topSkus,
      orders
    });
  }
  return result;
}

async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const days = Math.min(Math.max(Number(req.query.days || DEFAULT_DAYS), 1), MAX_DAYS);
  const onlyBranchId = clean(req.query.branchId);
  const dry = String(req.query.dry || '') === '1';

  const startedAt = Date.now();
  const errors = [];

  /* Voor elke dag van vandaag tot 'days' geleden: ophalen + aggregeren */
  const now = new Date();
  const branchDayMap = new Map(); /* branchId -> { 'YYYY-MM-DD': agg } */

  for (let d = 0; d < days; d++) {
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - d);
    const dayEnd = new Date(dayStart);
    dayEnd.setDate(dayEnd.getDate() + 1);
    /* End-of-day = 1 ms vóór de volgende dag */
    dayEnd.setSeconds(dayEnd.getSeconds() - 1);

    const dayKey = isoDay(dayStart);

    try {
      const r = await getTransactions({ from: iso(dayStart), until: iso(dayEnd) });
      const aggMap = aggregateDayForBranches(r.transactions || []);
      for (const [bid, agg] of aggMap.entries()) {
        if (onlyBranchId && bid !== onlyBranchId) continue;
        if (!branchDayMap.has(bid)) branchDayMap.set(bid, {});
        branchDayMap.get(bid)[dayKey] = agg;
      }
    } catch (error) {
      errors.push({ day: dayKey, message: error.message || 'onbekend' });
      console.error(`[revenue-cache] ${dayKey} faalde:`, error.message);
      /* Doorgaan met volgende dag */
    }
  }

  /* Wegschrijven per branch */
  const written = [];
  if (!dry) {
    for (const [bid, dayMap] of branchDayMap.entries()) {
      try {
        const saved = await mergeBranchRevenue(bid, dayMap);
        written.push({ branchId: bid, daysWritten: Object.keys(dayMap).length, totalDays: Object.keys(saved.days).length });
      } catch (error) {
        errors.push({ branchId: bid, message: error.message });
      }
    }

    /* Update index */
    try {
      const allBranches = listAllBranches();
      await writeRevenueIndex({
        branchIds: allBranches.map((b) => b.branchId),
        lastFullRefreshAt: new Date().toISOString()
      });
    } catch (error) {
      errors.push({ section: 'index', message: error.message });
    }
  }

  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  return res.status(200).json({
    success: true,
    dry,
    daysFetched: days,
    branchesProcessed: branchDayMap.size,
    written,
    errors,
    elapsedSec: elapsed,
    completedAt: new Date().toISOString()
  });
}

export default trackedCron('srs-revenue-cache', handler);
