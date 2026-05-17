import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getMailLog } from '../../lib/gents-mail-log-store.js';

/**
 * GET /api/admin/today-stats
 *
 * Snapshot van vandaag:
 *  - newOrders: nieuwe orders vandaag (Shopify)
 *  - revenue: totale omzet vandaag (Shopify orders)
 *  - newCustomers: nieuwe klantinschrijvingen vandaag
 *  - refunds: aantal retouren gestart vandaag
 *  - vs yesterday: trend per metric
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const today = startOfDay(new Date());
  const yesterday = startOfDay(new Date(Date.now() - 86400000));
  const tomorrow = new Date(today.getTime() + 86400000);

  /* Shopify orders fetch */
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN || 'gentsherenmode.myshopify.com';
  const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
  const configured = Boolean(shopifyToken);

  let newOrders = 0;
  let revenue = 0;
  let refunds = 0;
  let yesterdayOrders = 0;
  let yesterdayRevenue = 0;
  let shopifyError = '';

  if (shopifyToken) {
    try {
      const url = `https://${shopifyDomain}/admin/api/2024-01/orders.json?status=any&created_at_min=${yesterday.toISOString()}&created_at_max=${tomorrow.toISOString()}&limit=250`;
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': shopifyToken, Accept: 'application/json' } });
      if (r.ok) {
        const d = await r.json();
        const orders = d.orders || [];
        orders.forEach(o => {
          const created = new Date(o.created_at);
          const total = Number(o.total_price || 0);
          if (created >= today) {
            newOrders++;
            revenue += total;
          } else if (created >= yesterday) {
            yesterdayOrders++;
            yesterdayRevenue += total;
          }
          if ((o.refunds || []).some(rf => new Date(rf.created_at) >= today)) refunds++;
        });
      } else {
        shopifyError = `Shopify API ${r.status}`;
      }
    } catch (e) { shopifyError = e.message || 'fetch failed'; }
  }

  /* New customers — uit mail-log heuristisch (welcome mails) of niet vulbaar zonder Shopify Customers API */
  let newCustomers = 0;
  try {
    const logs = await getMailLog();
    newCustomers = logs.filter(l => {
      const dt = new Date(l.createdAt || 0);
      const isToday = dt >= today;
      const isCustomerMail = /welcome|customer|registration|signup/i.test(String(l.type || ''));
      return isToday && isCustomerMail;
    }).length;
  } catch (e) { /* skip */ }

  const trend = (today, prev) => {
    if (!prev) return null;
    const diff = ((today - prev) / prev) * 100;
    return Number(diff.toFixed(1));
  };

  return res.status(200).json({
    success: true,
    today: today.toISOString().slice(0, 10),
    configured,
    message: configured
      ? (shopifyError ? `Shopify fout: ${shopifyError}` : '')
      : 'SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel env-vars. Voeg token toe met read_orders scope om live data te zien.',
    metrics: {
      newOrders: { value: newOrders, prev: yesterdayOrders, trendPct: trend(newOrders, yesterdayOrders) },
      revenue:   { value: revenue,   prev: yesterdayRevenue, trendPct: trend(revenue, yesterdayRevenue) },
      newCustomers: { value: newCustomers, prev: null, trendPct: null },
      refunds:   { value: refunds, prev: null, trendPct: null }
    }
  });
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
