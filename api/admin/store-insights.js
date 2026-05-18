/**
 * GET /api/admin/store-insights?store=<store>&period=year|month|quarter|lifetime
 *
 * Winkel-inzicht uit SRS kassa-transacties (offline verkopen).
 * Aggregeert per winkel:
 *   - Per weekdag (Maandag → Zondag) omzet + transacties
 *   - Per uur (0-23) omzet + transacties (piekuren)
 *   - Top maten (uit SKU pattern: laatste segmenten zijn vaak maat)
 *   - Top kleuren (uit SKU pattern of itemDescription)
 *   - Fast movers (meest verkochte SKU's)
 *   - Slow movers (SKU's met laagste velocity die wel in voorraad zijn)
 *   - Algemene KPI's: AOV, gem. items per bon, repeat-customer %,
 *     gem. korting (charged vs listPrice)
 *
 * Response:
 *   {
 *     success, store, branchId, period, from, until,
 *     totals: { revenue, transactions, items, uniqueCustomers,
 *               avgOrderValue, avgItemsPerTransaction, repeatCustomerRate,
 *               avgDiscountPct },
 *     byDayOfWeek: [{ day: 'maandag', revenue, transactions, avgValue }],
 *     byHour: [{ hour: 0-23, revenue, transactions }],
 *     topSizes: [{ size, count, revenue }],
 *     topColors: [{ color, count, revenue }],
 *     fastMovers: [{ sku, pieces, revenue, transactions }],
 *     slowMovers: [{ sku, pieces, revenue, daysSinceLastSale }]
 *   }
 */

import { getTransactions } from '../../lib/srs-customers-client.js';
import { getBranchIdByStore } from '../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function isoDateTime(date) { return date.toISOString().slice(0, 19); }

function computeRange(period) {
  const now = new Date();
  const from = new Date(now);
  if (period === 'month')   from.setDate(from.getDate() - 30);
  else if (period === 'quarter') from.setMonth(from.getMonth() - 3);
  else if (period === 'lifetime') from.setFullYear(from.getFullYear() - 5);
  else from.setFullYear(from.getFullYear() - 1); /* year default */
  from.setHours(0, 0, 0, 0);
  return { from: isoDateTime(from), until: isoDateTime(now) };
}

const DAY_NAMES = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

/* Veelvoorkomende maat-tokens in SRS SKU's */
const SIZE_TOKENS = new Set([
  'XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL',
  '36','37','38','39','40','41','42','43','44','45','46','47','48','49','50','51','52','53','54','56','58','60','62','64',
  'W28','W29','W30','W31','W32','W33','W34','W35','W36','W38','W40','W42'
]);

/* Veelvoorkomende kleur-tokens (eenvoudige heuristiek) */
const COLOR_TOKENS = {
  'BLK': 'Zwart', 'ZWA': 'Zwart', 'BLACK': 'Zwart',
  'WHT': 'Wit', 'WIT': 'Wit', 'WHITE': 'Wit',
  'GRY': 'Grijs', 'GRI': 'Grijs', 'GREY': 'Grijs', 'GRAY': 'Grijs',
  'BLU': 'Blauw', 'BLA': 'Blauw', 'BLUE': 'Blauw', 'NAV': 'Navy', 'NAVY': 'Navy',
  'RED': 'Rood', 'ROD': 'Rood', 'ROOD': 'Rood',
  'GRN': 'Groen', 'GRO': 'Groen', 'GREEN': 'Groen',
  'BRN': 'Bruin', 'BRO': 'Bruin', 'BROWN': 'Bruin',
  'BEI': 'Beige', 'BEIGE': 'Beige', 'TAN': 'Beige',
  'CGN': 'Cognac', 'COGNAC': 'Cognac',
  'OFF': 'Off-white', 'CRM': 'Crème', 'CREAM': 'Crème'
};

function extractSizeFromSku(sku) {
  if (!sku) return null;
  const parts = String(sku).toUpperCase().split(/[-_\s\/]/).filter(Boolean);
  for (const p of parts.reverse()) {
    if (SIZE_TOKENS.has(p)) return p;
  }
  return null;
}

function extractColorFromSku(sku) {
  if (!sku) return null;
  const parts = String(sku).toUpperCase().split(/[-_\s\/]/).filter(Boolean);
  for (const p of parts) {
    if (COLOR_TOKENS[p]) return COLOR_TOKENS[p];
  }
  /* 3-letter color code als laatste fallback */
  for (const p of parts) {
    if (p.length === 3 && COLOR_TOKENS[p]) return COLOR_TOKENS[p];
  }
  return null;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = String(req.query.store || '').trim();
  const period = String(req.query.period || 'year').toLowerCase();
  if (!store) return res.status(400).json({ success: false, message: 'store query-param is verplicht.' });

  const branchId = getBranchIdByStore(store);
  if (!branchId) return res.status(400).json({ success: false, message: `Geen branchId voor "${store}".` });

  const { from, until } = computeRange(period);

  try {
    const result = await getTransactions({ from, until });
    const all = Array.isArray(result?.transactions) ? result.transactions : [];
    const txs = all.filter((t) => String(t.branchId || '') === String(branchId));

    /* Aggregeren */
    const byDay  = Array.from({ length: 7 }, () => ({ revenue: 0, transactions: 0 }));
    const byHour = Array.from({ length: 24 }, () => ({ revenue: 0, transactions: 0 }));
    const sizeMap = new Map();
    const colorMap = new Map();
    const skuMap = new Map();
    const customerIds = new Set();
    const customerOrderCount = new Map();

    let totalRevenue = 0;
    let totalItems = 0;
    let totalCharged = 0;
    let totalList = 0;

    for (const tx of txs) {
      const dt = tx.dateTime ? new Date(tx.dateTime) : null;
      const total = Number(tx.total || 0);
      totalRevenue += total;

      if (dt && !isNaN(dt.getTime())) {
        const d = dt.getDay();      /* 0=zondag */
        const h = dt.getHours();
        byDay[d].revenue += total;
        byDay[d].transactions += 1;
        byHour[h].revenue += total;
        byHour[h].transactions += 1;
      }

      if (tx.customerId) {
        customerIds.add(tx.customerId);
        customerOrderCount.set(tx.customerId, (customerOrderCount.get(tx.customerId) || 0) + 1);
      }

      /* Items */
      for (const item of (tx.items || [])) {
        const pieces = Number(item.pieces || 0);
        const charged = Number(item.charged || 0);
        const listPrice = Number(item.listPrice || 0);
        totalItems += pieces;
        totalCharged += charged;
        if (listPrice > 0) totalList += listPrice * pieces;

        const sku = String(item.sku || '').trim();
        if (sku) {
          const cur = skuMap.get(sku) || { sku, pieces: 0, revenue: 0, transactions: 0, lastSold: null };
          cur.pieces += pieces;
          cur.revenue += charged;
          cur.transactions += 1;
          if (dt && (!cur.lastSold || dt > cur.lastSold)) cur.lastSold = dt;
          skuMap.set(sku, cur);
        }

        const size = extractSizeFromSku(sku);
        if (size) {
          const cur = sizeMap.get(size) || { size, count: 0, revenue: 0 };
          cur.count += pieces;
          cur.revenue += charged;
          sizeMap.set(size, cur);
        }
        const color = extractColorFromSku(sku);
        if (color) {
          const cur = colorMap.get(color) || { color, count: 0, revenue: 0 };
          cur.count += pieces;
          cur.revenue += charged;
          colorMap.set(color, cur);
        }
      }
    }

    /* Totals */
    const totalTransactions = txs.length;
    const avgOrderValue = totalTransactions ? totalRevenue / totalTransactions : 0;
    const avgItemsPerTransaction = totalTransactions ? totalItems / totalTransactions : 0;
    const repeatCustomers = [...customerOrderCount.values()].filter((c) => c >= 2).length;
    const repeatCustomerRate = customerIds.size ? repeatCustomers / customerIds.size : 0;
    const avgDiscountPct = totalList > 0 ? Math.max(0, (totalList - totalCharged) / totalList) : 0;

    /* Sortering */
    const byDayOfWeek = byDay.map((d, i) => ({
      day: DAY_NAMES[i],
      dayIndex: i,
      revenue: Math.round(d.revenue * 100) / 100,
      transactions: d.transactions,
      avgValue: d.transactions ? Math.round((d.revenue / d.transactions) * 100) / 100 : 0
    }));

    const byHourArr = byHour.map((h, i) => ({
      hour: i,
      revenue: Math.round(h.revenue * 100) / 100,
      transactions: h.transactions
    }));

    const topSizes = [...sizeMap.values()].sort((a, b) => b.count - a.count).slice(0, 12).map((s) => ({
      ...s,
      revenue: Math.round(s.revenue * 100) / 100
    }));

    const topColors = [...colorMap.values()].sort((a, b) => b.count - a.count).slice(0, 12).map((c) => ({
      ...c,
      revenue: Math.round(c.revenue * 100) / 100
    }));

    const sortedSkus = [...skuMap.values()].sort((a, b) => b.pieces - a.pieces);
    const fastMovers = sortedSkus.slice(0, 10).map((s) => ({
      sku: s.sku,
      pieces: s.pieces,
      transactions: s.transactions,
      revenue: Math.round(s.revenue * 100) / 100,
      avgPrice: s.pieces ? Math.round((s.revenue / s.pieces) * 100) / 100 : 0
    }));

    /* Slow movers: minste verkopen, maar moet wel >0 zijn én laatste sale > 30 dagen geleden */
    const now = Date.now();
    const THIRTY_DAYS = 30 * 86400000;
    const slowMovers = [...skuMap.values()]
      .filter((s) => s.pieces > 0 && s.lastSold && (now - s.lastSold.getTime()) > THIRTY_DAYS)
      .sort((a, b) => a.pieces - b.pieces)
      .slice(0, 10)
      .map((s) => ({
        sku: s.sku,
        pieces: s.pieces,
        revenue: Math.round(s.revenue * 100) / 100,
        lastSold: s.lastSold?.toISOString().slice(0, 10) || null,
        daysSinceLastSale: s.lastSold ? Math.floor((now - s.lastSold.getTime()) / 86400000) : null
      }));

    return res.status(200).json({
      success: true,
      store,
      branchId,
      period,
      from,
      until,
      totals: {
        revenue: Math.round(totalRevenue * 100) / 100,
        transactions: totalTransactions,
        items: totalItems,
        uniqueCustomers: customerIds.size,
        repeatCustomers,
        repeatCustomerRate: Math.round(repeatCustomerRate * 1000) / 10,
        avgOrderValue: Math.round(avgOrderValue * 100) / 100,
        avgItemsPerTransaction: Math.round(avgItemsPerTransaction * 100) / 100,
        avgDiscountPct: Math.round(avgDiscountPct * 1000) / 10
      },
      byDayOfWeek,
      byHour: byHourArr,
      topSizes,
      topColors,
      fastMovers,
      slowMovers
    });
  } catch (error) {
    console.error('[store-insights]', error);
    return res.status(500).json({ success: false, message: error.message || 'Insights kon niet worden opgehaald.' });
  }
}
