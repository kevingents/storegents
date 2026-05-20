import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getTransactions } from '../../lib/srs-customers-client.js';
import { listBranches } from '../../lib/branch-metrics.js';

/**
 * GET /api/srs/store-revenue?store=GENTS Amersfoort&period=today|week|month
 *
 * Haalt de SRS-omzet voor de gegeven winkel + periode op via
 * GetTransactions (SOAP). Aggregeert per-branchId.
 *
 * Response:
 *   {
 *     success, store, branchId, period,
 *     from, until,
 *     totals: { revenue, transactionCount, itemsSold },
 *     previous: { revenue, transactionCount, trendPct },
 *     byHour: [{ hour, revenue, count }]   // alleen bij period=today
 *   }
 *
 * Caching: 5 min in-memory zodat dashboard-refreshes SRS niet hameren.
 */

const CACHE_TTL_MS = Number(process.env.STORE_REVENUE_CACHE_MS || 5 * 60 * 1000);
const cache = new Map();

function clean(value) { return String(value || '').trim(); }

function findBranchIdForStore(store) {
  const target = clean(store).toLowerCase();
  if (!target) return '';
  const branches = listBranches({ includeInternal: true });
  const match = branches.find((b) => clean(b.store).toLowerCase() === target);
  return match?.branchId || '';
}

function iso(d) { return d.toISOString().slice(0, 19); }

function computeRange(period, now = new Date()) {
  const p = clean(period).toLowerCase() || 'today';
  if (p === 'week') {
    /* Afgelopen 7 dagen incl. vandaag */
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
  /* default: today */
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const until = new Date(now);
  const prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 1);
  const prevUntil = new Date(until); prevUntil.setDate(prevUntil.getDate() - 1);
  return { from, until, prevFrom, prevUntil };
}

function aggregate(transactions, branchId) {
  let revenue = 0;
  let transactionCount = 0;
  let itemsSold = 0;
  const byHour = new Map();
  for (const tx of transactions || []) {
    if (branchId && String(tx.branchId) !== String(branchId)) continue;
    transactionCount += 1;
    const total = Number(tx.total || 0);
    revenue += total;
    if (Array.isArray(tx.items)) {
      for (const item of tx.items) itemsSold += Number(item.pieces || 0);
    }
    /* Hour-bucket voor today-view */
    if (tx.dateTime) {
      const hour = String(tx.dateTime).slice(11, 13);
      if (hour) {
        const slot = byHour.get(hour) || { hour, revenue: 0, count: 0 };
        slot.revenue += total;
        slot.count += 1;
        byHour.set(hour, slot);
      }
    }
  }
  return {
    revenue: Math.round(revenue * 100) / 100,
    transactionCount,
    itemsSold,
    byHour: Array.from(byHour.values()).sort((a, b) => a.hour.localeCompare(b.hour))
  };
}

async function fetchAggregated(branchId, from, until) {
  /* getTransactions returnt zonder customerId alle transacties in periode. */
  const result = await getTransactions({ from: iso(from), until: iso(until) });
  return aggregate(result.transactions || [], branchId);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = clean(req.query.store);
  const explicitBranchId = clean(req.query.branchId);
  const period = clean(req.query.period) || 'today';

  if (!store && !explicitBranchId) {
    return res.status(400).json({ success: false, message: 'Geef store of branchId mee.' });
  }

  const branchId = explicitBranchId || findBranchIdForStore(store);
  if (!branchId) {
    return res.status(400).json({ success: false, message: `Geen branchId gevonden voor winkel "${store}".` });
  }

  const range = computeRange(period);
  const cacheKey = `${branchId}|${period}|${iso(range.from)}|${iso(range.until)}`;

  if (!String(req.query.refresh || '') && cache.has(cacheKey)) {
    const entry = cache.get(cacheKey);
    if (Date.now() - entry.ts < CACHE_TTL_MS) {
      return res.status(200).json({ ...entry.data, cache: { hit: true, ageMs: Date.now() - entry.ts } });
    }
  }

  try {
    /* Parallel: current + previous period voor trend */
    const [current, previous] = await Promise.all([
      fetchAggregated(branchId, range.from, range.until),
      fetchAggregated(branchId, range.prevFrom, range.prevUntil)
    ]);

    const trendPct = previous.revenue
      ? Math.round(((current.revenue - previous.revenue) / previous.revenue) * 1000) / 10
      : null;

    const payload = {
      success: true,
      store: store || '',
      branchId,
      period,
      from: iso(range.from),
      until: iso(range.until),
      totals: {
        revenue: current.revenue,
        transactionCount: current.transactionCount,
        itemsSold: current.itemsSold
      },
      previous: {
        revenue: previous.revenue,
        transactionCount: previous.transactionCount,
        trendPct
      },
      byHour: period === 'today' ? current.byHour : []
    };

    cache.set(cacheKey, { ts: Date.now(), data: payload });
    /* Beperk cache-grootte */
    if (cache.size > 200) cache.delete(cache.keys().next().value);

    return res.status(200).json({ ...payload, cache: { hit: false } });
  } catch (error) {
    console.error('[store-revenue]', error);
    /* Fail-soft: return 200 met error-info zodat UI graceful kan degraderen */
    return res.status(200).json({
      success: false,
      store: store || '',
      branchId,
      period,
      message: error.message || 'SRS-fetch mislukt',
      totals: { revenue: 0, transactionCount: 0, itemsSold: 0 },
      previous: { revenue: 0, transactionCount: 0, trendPct: null },
      byHour: []
    });
  }
}
