/**
 * Pure compute-functie voor winkelinzicht.
 * Krijgt al-opgehaalde SRS-transacties + branchId + datum-range, en
 * berekent KPI's + aggregaten. Hergebruikt door de cron (nightly) en
 * door de live-endpoint (fallback).
 */

const DAY_NAMES = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

const SIZE_TOKENS = new Set([
  'XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL',
  '36','37','38','39','40','41','42','43','44','45','46','47','48','49','50','51','52','53','54','56','58','60','62','64',
  'W28','W29','W30','W31','W32','W33','W34','W35','W36','W38','W40','W42'
]);

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
  return null;
}

/**
 * @param transactions Array<{branchId, customerId, dateTime, total, items: [{sku, pieces, charged, listPrice}]}>
 * @param branchId String — alleen transacties voor deze branch worden geaggregeerd
 * @param fromIso ISO datetime
 * @param untilIso ISO datetime
 */
export function aggregateInsights(transactions, branchId, fromIso, untilIso) {
  const fromMs = new Date(fromIso).getTime();
  const untilMs = new Date(untilIso).getTime();

  const txs = (Array.isArray(transactions) ? transactions : [])
    .filter((t) => String(t.branchId || '') === String(branchId))
    .filter((t) => {
      if (!t.dateTime) return false;
      const ms = new Date(t.dateTime).getTime();
      return !isNaN(ms) && ms >= fromMs && ms <= untilMs;
    });

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
    const dt = new Date(tx.dateTime);
    const total = Number(tx.total || 0);
    totalRevenue += total;
    if (!isNaN(dt.getTime())) {
      const d = dt.getDay();
      const h = dt.getHours();
      byDay[d].revenue += total; byDay[d].transactions += 1;
      byHour[h].revenue += total; byHour[h].transactions += 1;
    }
    if (tx.customerId) {
      customerIds.add(tx.customerId);
      customerOrderCount.set(tx.customerId, (customerOrderCount.get(tx.customerId) || 0) + 1);
    }
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
        if (!cur.lastSold || dt > cur.lastSold) cur.lastSold = dt;
        skuMap.set(sku, cur);
      }
      const size = extractSizeFromSku(sku);
      if (size) {
        const cur = sizeMap.get(size) || { size, count: 0, revenue: 0 };
        cur.count += pieces; cur.revenue += charged;
        sizeMap.set(size, cur);
      }
      const color = extractColorFromSku(sku);
      if (color) {
        const cur = colorMap.get(color) || { color, count: 0, revenue: 0 };
        cur.count += pieces; cur.revenue += charged;
        colorMap.set(color, cur);
      }
    }
  }

  const totalTransactions = txs.length;
  const avgOrderValue = totalTransactions ? totalRevenue / totalTransactions : 0;
  const avgItemsPerTransaction = totalTransactions ? totalItems / totalTransactions : 0;
  const repeatCustomers = [...customerOrderCount.values()].filter((c) => c >= 2).length;
  const repeatCustomerRate = customerIds.size ? repeatCustomers / customerIds.size : 0;
  const avgDiscountPct = totalList > 0 ? Math.max(0, (totalList - totalCharged) / totalList) : 0;

  const byDayOfWeek = byDay.map((d, i) => ({
    day: DAY_NAMES[i], dayIndex: i,
    revenue: Math.round(d.revenue * 100) / 100,
    transactions: d.transactions,
    avgValue: d.transactions ? Math.round((d.revenue / d.transactions) * 100) / 100 : 0
  }));
  const byHourArr = byHour.map((h, i) => ({
    hour: i,
    revenue: Math.round(h.revenue * 100) / 100,
    transactions: h.transactions
  }));
  const topSizes = [...sizeMap.values()].sort((a, b) => b.count - a.count).slice(0, 12).map((s) => ({ ...s, revenue: Math.round(s.revenue * 100) / 100 }));
  const topColors = [...colorMap.values()].sort((a, b) => b.count - a.count).slice(0, 12).map((c) => ({ ...c, revenue: Math.round(c.revenue * 100) / 100 }));

  const sortedSkus = [...skuMap.values()].sort((a, b) => b.pieces - a.pieces);
  const fastMovers = sortedSkus.slice(0, 10).map((s) => ({
    sku: s.sku, pieces: s.pieces, transactions: s.transactions,
    revenue: Math.round(s.revenue * 100) / 100,
    avgPrice: s.pieces ? Math.round((s.revenue / s.pieces) * 100) / 100 : 0
  }));

  const now = Date.now();
  const THIRTY_DAYS = 30 * 86400000;
  const slowMovers = [...skuMap.values()]
    .filter((s) => s.pieces > 0 && s.lastSold && (now - s.lastSold.getTime()) > THIRTY_DAYS)
    .sort((a, b) => a.pieces - b.pieces)
    .slice(0, 10)
    .map((s) => ({
      sku: s.sku, pieces: s.pieces,
      revenue: Math.round(s.revenue * 100) / 100,
      lastSold: s.lastSold?.toISOString().slice(0, 10) || null,
      daysSinceLastSale: s.lastSold ? Math.floor((now - s.lastSold.getTime()) / 86400000) : null
    }));

  return {
    branchId,
    from: fromIso, until: untilIso,
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
    topSizes, topColors, fastMovers, slowMovers
  };
}

export function isoDateTime(date) { return date.toISOString().slice(0, 19); }

export function computeRange(period) {
  const now = new Date();
  const from = new Date(now);
  if (period === 'year') from.setFullYear(from.getFullYear() - 1);
  else if (period === 'quarter') from.setMonth(from.getMonth() - 3);
  else if (period === 'lifetime') from.setFullYear(from.getFullYear() - 5);
  else from.setDate(from.getDate() - 30); /* month default */
  from.setHours(0, 0, 0, 0);
  return { from: isoDateTime(from), until: isoDateTime(now) };
}

export const PERIODS = ['month', 'quarter', 'year', 'lifetime'];
