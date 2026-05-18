import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/store-customer-overview?period=month
 *
 * Combineert per winkel:
 *   - Top 5 klanten op omzet
 *   - % terugkerende klanten (binnen 60 dagen)
 *   - Aantal nieuwe inschrijvingen (uit SRS weekly-report)
 *   - Aantal nieuwe inschrijvingen ZONDER e-mail (compliance signaal)
 *
 * Bronnen:
 *   - Shopify orders.json (per-store + per-customer aggregatie)
 *   - /api/admin/customers/weekly-report (SRS customer inschrijvingen)
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const RETURNING_WINDOW_DAYS = 60;

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
  if (period === 'week') { from.setDate(from.getDate() - 7); }
  else if (period === 'year') { from.setFullYear(from.getFullYear() - 1); }
  else { from.setDate(from.getDate() - 30); /* month */ }
  from.setHours(0, 0, 0, 0);
  /* Voor returning rate hebben we orders 60 dagen vóór "from" ook nodig */
  const lookbackFrom = new Date(from);
  lookbackFrom.setDate(lookbackFrom.getDate() - RETURNING_WINDOW_DAYS);
  return { from, to: now, lookbackFrom };
}

function deriveStoreFromOrder(o) {
  const src = String(o.source_name || '').toLowerCase();
  if (src === 'pos') {
    const tags = String(o.tags || '').split(',').map((t) => t.trim());
    const storeTag = tags.find((t) => /^store:|^winkel:/i.test(t));
    if (storeTag) return storeTag.replace(/^(store|winkel):/i, '').trim();
    if (o.location_id) return `Locatie ${o.location_id}`;
    return 'GENTS Winkel (POS)';
  }
  if (src && src !== 'web' && src !== 'shopify_draft_order') return src.charAt(0).toUpperCase() + src.slice(1);
  return 'Webshop';
}

async function fetchOrders({ from, to, maxOrders }) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel.');
  }
  const shop = SHOPIFY_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const orders = [];
  let url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${from.toISOString()}&created_at_max=${to.toISOString()}&limit=250&fields=id,name,created_at,total_price,customer,source_name,location_id,tags`;

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

/* SRS weekly-report binnen-API call (internal fetch) — we hergebruiken bestaande logica */
async function fetchSrsCustomerReport(dateFrom, dateTo, originalReq) {
  /* Bouw absolute URL — Vercel runtime variabele of fallback naar local */
  const host = originalReq.headers['host'] || 'storegents.vercel.app';
  const protocol = host.startsWith('localhost') ? 'http' : 'https';
  const url = `${protocol}://${host}/api/admin/customers/monthly-store-report?dateFrom=${dateFrom}&dateTo=${dateTo}&t=${Date.now()}`;
  const adminToken = originalReq.headers['x-admin-token'] || originalReq.query.adminToken || process.env.ADMIN_TOKEN || '';
  try {
    const resp = await fetch(url, {
      headers: { 'x-admin-token': String(adminToken), Accept: 'application/json' }
    });
    if (!resp.ok) return { rows: [] };
    return await resp.json();
  } catch (_) {
    return { rows: [] };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const period = clean(req.query.period || 'month').toLowerCase();
  const maxOrders = Math.max(200, Math.min(3000, Number(req.query.maxOrders || 1500)));
  const { from, to, lookbackFrom } = computeRange(period);

  try {
    /* Parallel: Shopify orders (huidige + lookback) + SRS customer report */
    const [orders, srsReport] = await Promise.all([
      fetchOrders({ from: lookbackFrom, to, maxOrders }),
      fetchSrsCustomerReport(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10), req)
    ]);

    /* SRS rows (per branch) → naam-lookup voor mail-stats */
    const srsByStore = new Map();
    (srsReport.rows || []).forEach((row) => {
      srsByStore.set(row.store || row.branchName, {
        newCustomers: row.newCustomers || row.total || 0,
        withEmail: row.withEmail || 0,
        withoutEmail: row.withoutEmail || 0,
        emailRate: row.emailRate || 0,
        mailingOptIn: row.mailingOptIn || 0
      });
    });

    /* Per-store customer aggregatie */
    const byStore = new Map();
    for (const o of orders) {
      const cust = o.customer || {};
      const email = clean(cust.email).toLowerCase();
      const customerId = clean(cust.id);
      const key = email || customerId;
      if (!key) continue;
      const store = deriveStoreFromOrder(o);
      if (!byStore.has(store)) byStore.set(store, new Map());
      const custMap = byStore.get(store);
      const name = clean([cust.first_name, cust.last_name].filter(Boolean).join(' ')) || email;
      const orderDate = new Date(o.created_at);
      const cur = custMap.get(key) || {
        key, name, email, customerId,
        orders: 0,
        ordersInPeriod: 0,
        ordersInLookback: 0,
        spend: 0,
        dates: []
      };
      cur.orders += 1;
      cur.spend += Number(o.total_price || 0);
      cur.dates.push(orderDate);
      if (orderDate >= from) cur.ordersInPeriod += 1;
      else cur.ordersInLookback += 1;
      custMap.set(key, cur);
    }

    /* Voor elke winkel: bereken stats */
    const stores = [...byStore.entries()].map(([store, custMap]) => {
      const list = [...custMap.values()];
      const inPeriod = list.filter((c) => c.ordersInPeriod > 0);

      /* Returning customer logic:
         - Klant heeft 1+ order in periode (from..to)
         - EN heeft een eerdere order binnen RETURNING_WINDOW_DAYS daarvoor */
      let returningCount = 0;
      inPeriod.forEach((c) => {
        const sortedDates = [...c.dates].sort((a, b) => a - b);
        for (let i = 1; i < sortedDates.length; i++) {
          const daysBetween = (sortedDates[i] - sortedDates[i - 1]) / 86400000;
          if (sortedDates[i] >= from && daysBetween <= RETURNING_WINDOW_DAYS) {
            returningCount++;
            break;
          }
        }
      });

      const returningRate = inPeriod.length ? Math.round((returningCount / inPeriod.length) * 100) : 0;

      const top = list
        .filter((c) => c.ordersInPeriod > 0)
        .map((c) => ({
          key: c.key, name: c.name, email: c.email, customerId: c.customerId,
          orders: c.ordersInPeriod,
          spend: moneyNumber(c.spend),
          avgOrder: c.ordersInPeriod ? moneyNumber(c.spend / c.orders) : 0
        }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5);

      /* Match met SRS report op store-naam (fuzzy) */
      const srsMatch = srsByStore.get(store) ||
        [...srsByStore.entries()].find(([k]) => k.toLowerCase().includes(store.toLowerCase().replace(/^gents\s+/, '')))?.[1] ||
        null;

      return {
        store,
        uniqueCustomers: inPeriod.length,
        totalOrders: inPeriod.reduce((s, c) => s + c.ordersInPeriod, 0),
        totalSpend: moneyNumber(inPeriod.reduce((s, c) => s + c.spend, 0)),
        returningCount,
        returningRate,
        newRegistrations: srsMatch?.newCustomers || 0,
        newWithoutEmail: srsMatch?.withoutEmail || 0,
        newEmailRate: srsMatch?.emailRate ?? null,
        newMailingOptIn: srsMatch?.mailingOptIn || 0,
        top
      };
    }).sort((a, b) => b.totalSpend - a.totalSpend);

    return res.status(200).json({
      success: true,
      period,
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      returningWindowDays: RETURNING_WINDOW_DAYS,
      ordersScanned: orders.length,
      srsReportRows: (srsReport.rows || []).length,
      stores
    });
  } catch (error) {
    console.error('[admin/store-customer-overview]', error);
    return res.status(200).json({
      success: true,
      configured: !String(error.message || '').includes('ontbreekt in Vercel'),
      error: error.message || String(error),
      message: 'Overview kon niet worden berekend.',
      stores: []
    });
  }
}
