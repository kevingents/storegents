import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getTransactions } from '../../../lib/srs-customers-client.js';
import { readBranchSnapshot } from '../../../lib/srs-stock-snapshot-store.js';
import { isFeatureEnabled } from '../../../lib/feature-flags-store.js';

/**
 * GET /api/admin/suitconcer/dashboard
 *
 * Combined summary voor het Suitconcer dashboard. Eén endpoint, één call,
 * alle KPIs + recent orders + low-stock alerts + top producten:
 *
 *   {
 *     success,
 *     branchIds: { verkoop: '702', magazijn: '704' },
 *     today:       { revenue, transactionCount, itemsSold },
 *     thisWeek:    { revenue, transactionCount, trendPct },
 *     thisMonth:   { revenue, transactionCount },
 *     stock: {
 *       totalSkus, withStock, outOfStock,
 *       totalPieces, magazijnPieces, verkoopPieces,
 *       lowStock: [{ barcode, sku, title, color, size, totaal }]   // < threshold
 *     },
 *     recentOrders: [{ orderNr, receiptNr, dateTime, total, itemCount, customerId }],  // laatste 10
 *     topProducts:  [{ sku, title, pieces, revenue }]                                    // top 5 deze maand
 *   }
 *
 * Cache: 2 min in-memory.
 */

const VERKOOP = '702';
const MAGAZIJN = '704';
const LOW_STOCK_THRESHOLD = Number(process.env.SUITCONCER_LOW_STOCK_THRESHOLD || 5);
const CACHE_TTL_MS = Number(process.env.SUITCONCER_DASHBOARD_CACHE_MS || 2 * 60 * 1000);
let cached = { at: 0, data: null };

function clean(v) { return String(v || '').trim(); }
function iso(d) { return d.toISOString().slice(0, 19); }

function todayRange(now = new Date()) {
  const from = new Date(now); from.setHours(0, 0, 0, 0);
  const until = new Date(now);
  return { from, until };
}
function weekRange(now = new Date()) {
  const until = new Date(now);
  const from = new Date(now); from.setDate(from.getDate() - 6); from.setHours(0, 0, 0, 0);
  const prevUntil = new Date(from); prevUntil.setSeconds(prevUntil.getSeconds() - 1);
  const prevFrom = new Date(prevUntil); prevFrom.setDate(prevFrom.getDate() - 6); prevFrom.setHours(0, 0, 0, 0);
  return { from, until, prevFrom, prevUntil };
}
function monthRange(now = new Date()) {
  const from = new Date(now.getFullYear(), now.getMonth(), 1);
  const until = new Date(now);
  return { from, until };
}

function summarizeTransactions(transactions) {
  let revenue = 0;
  let itemsSold = 0;
  let transactionCount = 0;
  const productMap = new Map();
  const orders = [];

  for (const tx of transactions) {
    if (String(tx.branchId || '') !== VERKOOP) continue;
    const total = Number(tx.total || 0);
    revenue += total;
    transactionCount += 1;
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
      const key = it.sku || it.lineNr || `tx${tx.receiptNr}`;
      const p = productMap.get(key) || { sku: it.sku || '-', title: it.sku || '-', pieces: 0, revenue: 0 };
      p.pieces += Number(it.pieces || 0);
      p.revenue += Number(it.charged || 0);
      productMap.set(key, p);
    }
  }

  return {
    revenue: Number(revenue.toFixed(2)),
    transactionCount,
    itemsSold,
    orders: orders.sort((a, b) => String(b.dateTime).localeCompare(String(a.dateTime))),
    topProducts: Array.from(productMap.values())
      .map((p) => ({ ...p, revenue: Number(p.revenue.toFixed(2)) }))
      .sort((a, b) => b.pieces - a.pieces)
      .slice(0, 5)
  };
}

async function buildStockSummary() {
  const [verkoopSnap, magazijnSnap] = await Promise.all([
    readBranchSnapshot(VERKOOP),
    readBranchSnapshot(MAGAZIJN)
  ]);

  const byBarcode = new Map();

  for (const r of (verkoopSnap?.rows || [])) {
    const barcode = clean(r.barcode);
    if (!barcode) continue;
    byBarcode.set(barcode, {
      barcode,
      sku: clean(r.sku || r.barcode),
      title: clean(r.title || ''),
      color: clean(r.color || ''),
      size: clean(r.size || ''),
      verkoop: Number(r.pieces || 0),
      magazijn: 0
    });
  }
  for (const r of (magazijnSnap?.rows || [])) {
    const barcode = clean(r.barcode);
    if (!barcode) continue;
    const existing = byBarcode.get(barcode) || {
      barcode,
      sku: clean(r.sku || r.barcode),
      title: clean(r.title || ''),
      color: clean(r.color || ''),
      size: clean(r.size || ''),
      verkoop: 0,
      magazijn: 0
    };
    existing.magazijn = Number(r.pieces || 0);
    if (!existing.title && r.title) existing.title = clean(r.title);
    byBarcode.set(barcode, existing);
  }

  const all = Array.from(byBarcode.values()).map((r) => ({ ...r, totaal: r.verkoop + r.magazijn }));

  /* Low-stock alert: items met >0 maar onder threshold (uitverkocht = 0 valt er buiten) */
  const lowStock = all
    .filter((r) => r.totaal > 0 && r.totaal < LOW_STOCK_THRESHOLD)
    .sort((a, b) => a.totaal - b.totaal)
    .slice(0, 20);

  return {
    totalSkus: byBarcode.size,
    withStock: all.filter((r) => r.totaal > 0).length,
    outOfStock: all.filter((r) => r.totaal === 0).length,
    totalPieces: all.reduce((s, r) => s + r.totaal, 0),
    verkoopPieces: all.reduce((s, r) => s + r.verkoop, 0),
    magazijnPieces: all.reduce((s, r) => s + r.magazijn, 0),
    lowStock,
    snapshotUpdatedAt: {
      verkoop: verkoopSnap?.updatedAt || null,
      magazijn: magazijnSnap?.updatedAt || null
    }
  };
}

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

  /* Cache check */
  if (cached.data && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    const todayR = todayRange();
    const weekR = weekRange();
    const monthR = monthRange();

    /* Parallel: 3 SRS-calls + 1 stock-summary */
    const [todayTx, weekTx, weekPrevTx, monthTx, stockSummary] = await Promise.all([
      getTransactions({ from: iso(todayR.from), until: iso(todayR.until) }),
      getTransactions({ from: iso(weekR.from), until: iso(weekR.until) }),
      getTransactions({ from: iso(weekR.prevFrom), until: iso(weekR.prevUntil) }),
      getTransactions({ from: iso(monthR.from), until: iso(monthR.until) }),
      buildStockSummary()
    ]);

    const todaySum = summarizeTransactions(todayTx.transactions || []);
    const weekSum = summarizeTransactions(weekTx.transactions || []);
    const weekPrevSum = summarizeTransactions(weekPrevTx.transactions || []);
    const monthSum = summarizeTransactions(monthTx.transactions || []);

    const trendPct = weekPrevSum.revenue
      ? Number((((weekSum.revenue - weekPrevSum.revenue) / weekPrevSum.revenue) * 100).toFixed(1))
      : null;

    const data = {
      success: true,
      generatedAt: new Date().toISOString(),
      branchIds: { verkoop: VERKOOP, magazijn: MAGAZIJN },
      today: {
        revenue: todaySum.revenue,
        transactionCount: todaySum.transactionCount,
        itemsSold: todaySum.itemsSold
      },
      thisWeek: {
        revenue: weekSum.revenue,
        transactionCount: weekSum.transactionCount,
        trendPct
      },
      thisMonth: {
        revenue: monthSum.revenue,
        transactionCount: monthSum.transactionCount,
        itemsSold: monthSum.itemsSold,
        avgOrderValue: monthSum.transactionCount
          ? Number((monthSum.revenue / monthSum.transactionCount).toFixed(2))
          : 0
      },
      stock: stockSummary,
      recentOrders: monthSum.orders.slice(0, 10),
      topProducts: monthSum.topProducts,
      lowStockThreshold: LOW_STOCK_THRESHOLD
    };

    cached = { at: Date.now(), data };
    return res.status(200).json(data);
  } catch (error) {
    console.error('[suitconcer/dashboard] error:', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      message: error.message || 'Dashboard data kon niet worden opgehaald.',
      today: { revenue: 0, transactionCount: 0, itemsSold: 0 },
      thisWeek: { revenue: 0, transactionCount: 0, trendPct: null },
      thisMonth: { revenue: 0, transactionCount: 0, itemsSold: 0, avgOrderValue: 0 },
      stock: { totalSkus: 0, withStock: 0, outOfStock: 0, totalPieces: 0, lowStock: [] },
      recentOrders: [],
      topProducts: []
    });
  }
}
