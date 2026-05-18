import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/top-customers?period=month|week|year&limit=10&metric=spend|count
 *
 * Aggregeert Shopify orders per klant en geeft top N terug.
 * Bron: Shopify Admin REST orders.json paginated.
 *
 * Response:
 *   { success, totals, period, customers: [{name, email, customerId, orders, spend, lastOrderAt}] }
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function clean(value) { return String(value || '').trim(); }
function moneyNumber(value) { return Math.round(Number(value || 0) * 100) / 100; }

function computeRange(period) {
  const now = new Date();
  const from = new Date(now);
  if (period === 'week') { from.setDate(from.getDate() - 7); from.setHours(0,0,0,0); }
  else if (period === 'year') { from.setFullYear(from.getFullYear() - 1); from.setHours(0,0,0,0); }
  else if (period === 'lifetime') { from.setFullYear(from.getFullYear() - 5); from.setHours(0,0,0,0); }
  else { from.setDate(from.getDate() - 30); from.setHours(0,0,0,0); /* month default */ }
  return { from, to: now };
}

async function fetchOrders({ from, to, maxOrders }) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel.');
  }
  const shop = SHOPIFY_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const orders = [];
  /* source_name + location_id + tags toegevoegd voor per-winkel attributie */
  let url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${from.toISOString()}&created_at_max=${to.toISOString()}&limit=250&fields=id,name,created_at,total_price,customer,refunds,source_name,location_id,tags`;

  while (url && orders.length < maxOrders) {
    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, Accept: 'application/json' }
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Shopify orders.json ${resp.status} — ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    orders.push(...(data.orders || []));
    const linkHeader = resp.headers.get('link') || resp.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return orders.slice(0, maxOrders);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const period = clean(req.query.period || 'month').toLowerCase();
  const metric = clean(req.query.metric || 'spend').toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit || 10)));
  const maxOrders = Math.max(100, Math.min(2000, Number(req.query.maxOrders || 1000)));
  const groupBy = clean(req.query.groupBy || '').toLowerCase(); /* 'store' = per-winkel breakdown */
  const storeFilter = clean(req.query.store).toLowerCase();
  const { from, to } = computeRange(period);

  /* Helper: detecteer winkel-naam uit order */
  function deriveStoreFromOrder(o) {
    const src = String(o.source_name || '').toLowerCase();
    if (src && src !== 'web' && src !== 'shopify_draft_order' && src !== 'unknown') {
      /* POS orders hebben source_name = 'pos' meestal */
      if (src === 'pos') {
        /* Probeer tag-based winkel-naam: tags zoals 'store:GENTS Amsterdam' */
        const tags = String(o.tags || '').split(',').map((t) => t.trim());
        const storeTag = tags.find((t) => /^store:|^winkel:/i.test(t));
        if (storeTag) return storeTag.replace(/^(store|winkel):/i, '').trim();
        if (o.location_id) return `Locatie ${o.location_id}`;
        return 'GENTS Winkel (POS)';
      }
      return src.charAt(0).toUpperCase() + src.slice(1);
    }
    return 'Webshop';
  }

  try {
    const orders = await fetchOrders({ from, to, maxOrders });

    /* Optionele store-filter pre-pass */
    const filteredOrders = storeFilter
      ? orders.filter((o) => deriveStoreFromOrder(o).toLowerCase().includes(storeFilter))
      : orders;

    /* Per-store breakdown */
    if (groupBy === 'store') {
      const byStore = new Map();
      for (const o of filteredOrders) {
        const cust = o.customer || {};
        const email = clean(cust.email).toLowerCase();
        const customerId = clean(cust.id);
        const key = email || customerId;
        if (!key) continue;
        const store = deriveStoreFromOrder(o);
        if (!byStore.has(store)) byStore.set(store, new Map());
        const custMap = byStore.get(store);
        const name = clean([cust.first_name, cust.last_name].filter(Boolean).join(' ')) || email;
        const cur = custMap.get(key) || { key, name, email, customerId, orders: 0, spend: 0, lastOrderAt: null };
        cur.orders += 1;
        cur.spend += Number(o.total_price || 0);
        const d = o.created_at;
        if (d && (!cur.lastOrderAt || d > cur.lastOrderAt)) cur.lastOrderAt = d;
        custMap.set(key, cur);
      }
      const storesResult = [...byStore.entries()]
        .map(([store, custMap]) => {
          const list = [...custMap.values()].map((c) => ({ ...c, spend: moneyNumber(c.spend), avgOrder: c.orders ? moneyNumber(c.spend / c.orders) : 0 }));
          return {
            store,
            uniqueCustomers: list.length,
            totalOrders: list.reduce((s, c) => s + c.orders, 0),
            totalSpend: moneyNumber(list.reduce((s, c) => s + c.spend, 0)),
            top: list.sort((a, b) => metric === 'count' ? b.orders - a.orders : b.spend - a.spend).slice(0, limit)
          };
        })
        .sort((a, b) => b.totalSpend - a.totalSpend);
      return res.status(200).json({
        success: true,
        mode: 'group_by_store',
        period,
        metric,
        range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
        ordersScanned: orders.length,
        stores: storesResult
      });
    }

    const byCustomer = new Map();
    for (const o of filteredOrders) {
      const cust = o.customer || {};
      const email = clean(cust.email).toLowerCase();
      const customerId = clean(cust.id);
      const key = email || customerId;
      if (!key) continue;
      const name = clean([cust.first_name, cust.last_name].filter(Boolean).join(' ')) || email;
      const cur = byCustomer.get(key) || {
        key,
        name,
        email,
        customerId,
        orders: 0,
        spend: 0,
        refundedSpend: 0,
        lastOrderAt: null,
        firstOrderAt: null
      };
      cur.orders += 1;
      cur.spend += Number(o.total_price || 0);
      const refundedAmt = (o.refunds || []).reduce((s, r) => {
        return s + (r.transactions || []).reduce((ss, t) => ss + Number(t.amount || 0), 0);
      }, 0);
      cur.refundedSpend += refundedAmt;
      const d = o.created_at;
      if (d && (!cur.lastOrderAt || d > cur.lastOrderAt)) cur.lastOrderAt = d;
      if (d && (!cur.firstOrderAt || d < cur.firstOrderAt)) cur.firstOrderAt = d;
      byCustomer.set(key, cur);
    }

    const list = [...byCustomer.values()].map((c) => ({
      ...c,
      spend: moneyNumber(c.spend),
      refundedSpend: moneyNumber(c.refundedSpend),
      netSpend: moneyNumber(c.spend - c.refundedSpend),
      avgOrder: c.orders ? moneyNumber(c.spend / c.orders) : 0
    }));

    const sorted = list.sort((a, b) => {
      if (metric === 'count') return b.orders - a.orders;
      if (metric === 'net') return b.netSpend - a.netSpend;
      return b.spend - a.spend;
    }).slice(0, limit);

    const totals = {
      ordersScanned: orders.length,
      uniqueCustomers: byCustomer.size,
      totalSpend: moneyNumber(list.reduce((s, c) => s + c.spend, 0)),
      avgOrder: orders.length ? moneyNumber(list.reduce((s, c) => s + c.spend, 0) / orders.length) : 0
    };

    return res.status(200).json({
      success: true,
      period,
      metric,
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      totals,
      customers: sorted
    });
  } catch (error) {
    console.error('[admin/top-customers]', error);
    return res.status(200).json({
      success: true,
      configured: !String(error.message || '').includes('ontbreekt in Vercel'),
      error: error.message || 'Top-customers fout',
      message: 'Top-customers kon niet worden berekend.',
      totals: { ordersScanned: 0, uniqueCustomers: 0, totalSpend: 0, avgOrder: 0 },
      customers: []
    });
  }
}
