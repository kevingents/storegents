import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';

/**
 * GET /api/admin/revenue?period=today|week|month
 *
 * Haalt Shopify orders op voor de gekozen periode en aggregeert:
 *  - totalRevenue, orderCount, avgOrderValue
 *  - perStore[]: omzet per winkel
 *  - topProducts[]: top 10 producten op aantal verkocht
 *  - byDay[]: dagelijkse omzet voor mini-chart
 *  - vs previous period: trend %
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const period = String(req.query.period || 'today').toLowerCase();
  const storeFilter = String(req.query.store || '').trim();

  const range = computeRange(period);

  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN || 'gentsherenmode.myshopify.com';
  const shopifyToken = process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';

  if (!shopifyToken) {
    return res.status(200).json({
      success: true,
      period,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      configured: false,
      message: 'SHOPIFY_ADMIN_API_TOKEN ontbreekt in Vercel env-vars. Configureer Shopify Admin API token met read_orders scope.',
      totals: { totalRevenue: 0, orderCount: 0, avgOrderValue: 0, refundedRevenue: 0, netRevenue: 0 },
      previous: { totalRevenue: 0, orderCount: 0, trendPct: null },
      perStore: [],
      topProducts: [],
      byDay: []
    });
  }

  try {
    const current  = await fetchShopifyOrders(shopifyDomain, shopifyToken, range.from, range.to);
    const previous = await fetchShopifyOrders(shopifyDomain, shopifyToken, range.prevFrom, range.prevTo);

    const cur = aggregate(current, storeFilter, range);
    const prev = aggregate(previous, storeFilter, range);
    const trendPct = prev.totalRevenue ? Number((((cur.totalRevenue - prev.totalRevenue) / prev.totalRevenue) * 100).toFixed(1)) : null;

    return res.status(200).json({
      success: true,
      period,
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      configured: true,
      totals: cur,
      previous: { totalRevenue: prev.totalRevenue, orderCount: prev.orderCount, trendPct },
      perStore: cur.perStore,
      topProducts: cur.topProducts,
      byDay: cur.byDay
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Shopify orders fetch faalde.' });
  }
}

function computeRange(period) {
  const now = new Date();
  const to = new Date(now);
  const from = new Date(now);
  if (period === 'week') {
    from.setDate(from.getDate() - 7); from.setHours(0,0,0,0);
  } else if (period === 'month') {
    from.setDate(from.getDate() - 30); from.setHours(0,0,0,0);
  } else if (period === 'year') {
    from.setFullYear(from.getFullYear() - 1); from.setHours(0,0,0,0);
  } else {
    from.setHours(0,0,0,0); /* today */
  }
  const prevFrom = new Date(from);
  const prevTo = new Date(from);
  const periodMs = to.getTime() - from.getTime();
  prevFrom.setTime(prevFrom.getTime() - periodMs);
  return { from, to, prevFrom, prevTo };
}

async function fetchShopifyOrders(domain, token, from, to) {
  const url = `https://${domain}/admin/api/2024-01/orders.json?status=any&created_at_min=${from.toISOString()}&created_at_max=${to.toISOString()}&limit=250&fields=id,name,created_at,total_price,subtotal_price,total_discounts,refunds,line_items,source_name,tags,customer`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': token, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Shopify API ${r.status}`);
  const d = await r.json();
  return d.orders || [];
}

function aggregate(orders, storeFilter, range) {
  let totalRevenue = 0;
  let refundedRevenue = 0;
  let orderCount = 0;
  const storeMap = new Map();
  const productMap = new Map();
  const dayMap = new Map();

  orders.forEach(o => {
    const store = inferStore(o);
    if (storeFilter && store !== storeFilter) return;

    const total = Number(o.total_price || 0);
    const refunded = (o.refunds || []).reduce((s, rf) => s + (rf.transactions || []).reduce((ss, tx) => ss + Number(tx.amount || 0), 0), 0);

    totalRevenue += total;
    refundedRevenue += refunded;
    orderCount++;

    const cur = storeMap.get(store) || { store, revenue: 0, orderCount: 0 };
    cur.revenue += total;
    cur.orderCount++;
    storeMap.set(store, cur);

    (o.line_items || []).forEach(li => {
      const key = li.product_id || li.sku || li.title;
      const cur = productMap.get(key) || { title: li.title, sku: li.sku, quantity: 0, revenue: 0 };
      cur.quantity += Number(li.quantity || 0);
      cur.revenue += Number(li.price || 0) * Number(li.quantity || 0);
      productMap.set(key, cur);
    });

    const day = String(o.created_at).slice(0, 10);
    const dayCur = dayMap.get(day) || { day, revenue: 0, orderCount: 0 };
    dayCur.revenue += total;
    dayCur.orderCount++;
    dayMap.set(day, dayCur);
  });

  return {
    totalRevenue: Number(totalRevenue.toFixed(2)),
    refundedRevenue: Number(refundedRevenue.toFixed(2)),
    netRevenue: Number((totalRevenue - refundedRevenue).toFixed(2)),
    orderCount,
    avgOrderValue: orderCount ? Number((totalRevenue / orderCount).toFixed(2)) : 0,
    perStore: [...storeMap.values()].sort((a, b) => b.revenue - a.revenue),
    topProducts: [...productMap.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10),
    byDay: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day))
  };
}

function inferStore(order) {
  /* Tag-based attribution — Shopify orders krijgen via SRS-flow vaak een store-tag of source_name */
  const tags = String(order.tags || '').split(',').map(t => t.trim());
  const storeTag = tags.find(t => /^GENTS\s/i.test(t));
  if (storeTag) return storeTag;
  if (order.source_name && /^GENTS/i.test(order.source_name)) return order.source_name;
  return 'Onbekend';
}
