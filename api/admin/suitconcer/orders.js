import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getTransactions } from '../../../lib/srs-customers-client.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';

/**
 * GET /api/admin/suitconcer/orders?period=today|week|month|year
 *
 * Orders / transacties van branch 702 (Suitconcer verkoop).
 *
 * Wordt later uitgebreid wanneer de Shopify B2B-website live gaat:
 *   - Joinen met Shopify order-data (klant, factuuradres, PO-nr)
 *   - Status van fulfillment (verzonden, in transit, etc.)
 *   - Offerte → order conversie tracking
 *
 * Voor nu: pure SRS GetTransactions filter op branchId=702.
 *
 * Response:
 *   {
 *     success, period, range,
 *     totals: { revenue, transactionCount, avgValue, itemsSold },
 *     previous: { revenue, transactionCount, trendPct },
 *     orders: [{ receiptNr, orderNr, dateTime, total, items, customerId, personnelId }]
 *   }
 */

const SUITCONCER_BRANCH = '702';
const CACHE_TTL_MS = Number(process.env.SUITCONCER_ORDERS_CACHE_MS || 2 * 60 * 1000);
const cache = new Map();

function clean(v) { return String(v || '').trim(); }
function iso(d) { return d.toISOString().slice(0, 19); }

function computeRange(period, now = new Date()) {
  const p = clean(period).toLowerCase() || 'month';
  if (p === 'today') {
    const from = new Date(now); from.setHours(0, 0, 0, 0);
    const until = new Date(now);
    const prevFrom = new Date(from); prevFrom.setDate(prevFrom.getDate() - 1);
    const prevUntil = new Date(until); prevUntil.setDate(prevUntil.getDate() - 1);
    return { from, until, prevFrom, prevUntil };
  }
  if (p === 'week') {
    const until = new Date(now);
    const from = new Date(now); from.setDate(from.getDate() - 6); from.setHours(0, 0, 0, 0);
    const prevUntil = new Date(from); prevUntil.setSeconds(prevUntil.getSeconds() - 1);
    const prevFrom = new Date(prevUntil); prevFrom.setDate(prevFrom.getDate() - 6); prevFrom.setHours(0, 0, 0, 0);
    return { from, until, prevFrom, prevUntil };
  }
  if (p === 'year') {
    const from = new Date(now.getFullYear(), 0, 1);
    const until = new Date(now);
    const prevFrom = new Date(now.getFullYear() - 1, 0, 1);
    const prevUntil = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59);
    return { from, until, prevFrom, prevUntil };
  }
  /* month (default) */
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const until = new Date(now);
  const prevFrom = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevUntil = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  return { from, until, prevFrom, prevUntil };
}

function aggregate(transactions) {
  let revenue = 0;
  let itemsSold = 0;
  const orders = [];
  for (const tx of transactions) {
    if (String(tx.branchId || '') !== SUITCONCER_BRANCH) continue;
    const total = Number(tx.total || 0);
    revenue += total;
    const pieces = (tx.items || []).reduce((s, it) => s + Number(it.pieces || 0), 0);
    itemsSold += pieces;
    orders.push({
      receiptNr: tx.receiptNr || '',
      orderNr: tx.orderNr || '',
      dateTime: tx.dateTime || '',
      total: Number(total.toFixed(2)),
      itemCount: pieces,
      lineCount: (tx.items || []).length,
      customerId: tx.customerId || '',
      personnelId: tx.personnelId || '',
      items: (tx.items || []).map((it) => ({
        sku: it.sku,
        pieces: Number(it.pieces || 0),
        charged: Number(it.charged || 0),
        vat: Number(it.vat || 0)
      }))
    });
  }
  orders.sort((a, b) => String(b.dateTime).localeCompare(String(a.dateTime)));
  return {
    revenue: Number(revenue.toFixed(2)),
    transactionCount: orders.length,
    avgValue: orders.length ? Number((revenue / orders.length).toFixed(2)) : 0,
    itemsSold,
    orders
  };
}

export const maxDuration = 60;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  if (!(await isFeatureEnabled('suitconcer'))) {
    return res.status(403).json({
      success: false,
      message: 'Suitconcer is uitgeschakeld. Zet de feature aan in Instellingen.'
    });
  }

  const period = clean(req.query.period || 'month').toLowerCase();
  const range = computeRange(period);
  const cacheKey = `${period}|${iso(range.from)}|${iso(range.until)}`;

  const cached = cache.get(cacheKey);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    const [curTx, prevTx] = await Promise.all([
      getTransactions({ from: iso(range.from), until: iso(range.until) }),
      getTransactions({ from: iso(range.prevFrom), until: iso(range.prevUntil) })
    ]);

    const cur = aggregate(curTx.transactions || []);
    const prev = aggregate(prevTx.transactions || []);
    const trendPct = prev.revenue
      ? Number((((cur.revenue - prev.revenue) / prev.revenue) * 100).toFixed(1))
      : null;

    const data = {
      success: true,
      period,
      branchId: SUITCONCER_BRANCH,
      range: { from: range.from.toISOString(), to: range.until.toISOString() },
      totals: {
        revenue: cur.revenue,
        transactionCount: cur.transactionCount,
        avgValue: cur.avgValue,
        itemsSold: cur.itemsSold
      },
      previous: {
        revenue: prev.revenue,
        transactionCount: prev.transactionCount,
        trendPct
      },
      orders: cur.orders
    };

    cache.set(cacheKey, { at: Date.now(), data });
    return res.status(200).json(data);
  } catch (error) {
    console.error('[suitconcer/orders] error:', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      period,
      branchId: SUITCONCER_BRANCH,
      message: error.message || 'SRS GetTransactions faalde.',
      totals: { revenue: 0, transactionCount: 0, avgValue: 0, itemsSold: 0 },
      previous: { revenue: 0, transactionCount: 0, trendPct: null },
      orders: []
    });
  }
}
