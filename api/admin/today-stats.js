import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getMailLog } from '../../lib/gents-mail-log-store.js';
import { getTransactions } from '../../lib/srs-customers-client.js';

/**
 * GET /api/admin/today-stats
 *
 * Snapshot van vandaag:
 *  - newOrders: nieuwe orders vandaag (Shopify weborders)
 *  - revenue: omzet vandaag = SRS-bonnen (winkel) + Shopify webshop netto
 *  - storeRevenue: alleen winkel-bonnen (SRS, pure POS)
 *  - webshopRevenue: webshop netto (Shopify − refunds − cancelled)
 *  - newCustomers: nieuwe klantinschrijvingen vandaag
 *  - refunds: aantal retouren gestart vandaag
 *  - vs yesterday: trend per metric
 *
 * Business rules:
 *  - Winkel-omzet = SRS bonnen met receiptNr én ZONDER orderNr (pure POS)
 *  - Webshop-omzet = Shopify orders − refunds − cancelled
 *  - Totaal = winkel + webshop netto (geen overlap, geen dubbeltelling)
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

  /* Shopify orders fetch — match standaard codebase env-vars */
  const shopifyDomain = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
  const shopifyToken = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
  const apiVersion = process.env.SHOPIFY_API_VERSION || '2025-01';
  const configured = Boolean(shopifyToken && shopifyDomain);

  /* Webshop-data (Shopify): orders, refunds, cancellations */
  let webshopOrders = 0;
  let webshopRevenue = 0;       /* bruto */
  let webshopRefunded = 0;
  let webshopCancelled = 0;
  let webshopOrdersY = 0;
  let webshopRevenueY = 0;
  let webshopRefundedY = 0;
  let webshopCancelledY = 0;
  let refunds = 0;              /* aantal refund-events vandaag */
  let shopifyError = '';

  if (configured) {
    try {
      const url = `https://${shopifyDomain}/admin/api/${apiVersion}/orders.json?status=any&created_at_min=${yesterday.toISOString()}&created_at_max=${tomorrow.toISOString()}&limit=250`;
      const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': shopifyToken, Accept: 'application/json' } });
      if (r.ok) {
        const d = await r.json();
        const orders = d.orders || [];
        orders.forEach(o => {
          /* Offline winkel-bonnen via SRS storeRevenue al meegeteld — niet dubbel tellen */
          const oTags = String(o.tags || '').split(',').map(t => t.trim());
          if (oTags.includes('gents-offline')) return;

          const created = new Date(o.created_at);
          const total = Number(o.total_price || 0);
          const refunded = (o.refunds || []).reduce((s, rf) => s + (rf.transactions || []).reduce((ss, tx) => ss + Number(tx.amount || 0), 0), 0);
          /* Fix dubbelaftrek: bij betaalde annuleringen maakt Shopify een automatische
             refund-transactie. Als we zowel cancelledRevenue als refundedRevenue optellen
             wordt het bedrag twee keer afgetrokken. Oplossing: per order kiezen:
             geannuleerd → cancelledRevenue; actief → refundedRevenue. */
          const isCancelled = Boolean(o.cancelled_at);
          if (created >= today) {
            webshopOrders++;
            webshopRevenue += total;
            if (isCancelled) { webshopCancelled += total; }
            else              { webshopRefunded += refunded; }
          } else if (created >= yesterday) {
            webshopOrdersY++;
            webshopRevenueY += total;
            if (isCancelled) { webshopCancelledY += total; }
            else              { webshopRefundedY += refunded; }
          }
          if ((o.refunds || []).some(rf => new Date(rf.created_at) >= today)) refunds++;
        });
      } else {
        shopifyError = `Shopify API ${r.status}`;
      }
    } catch (e) { shopifyError = e.message || 'fetch failed'; }
  }

  /* Winkel-bonnen (SRS): pure POS-aankopen vandaag + gisteren — split
     in bruto + retour zodat dashboard-KPI consistent is met de omzet-
     detailpagina (revenue-srs splitst ook). */
  let storeOrders = 0;
  let storeRevenue = 0;        /* netto = bruto − retour */
  let storeGross = 0;          /* alleen positieve items */
  let storeRefunded = 0;       /* absolute waarde negatieve items */
  let storeOrdersY = 0;
  let storeRevenueY = 0;
  let storeGrossY = 0;
  let storeRefundedY = 0;
  let srsError = '';

  try {
    const srsRes = await getTransactions({
      from: yesterday.toISOString().slice(0, 19),
      until: tomorrow.toISOString().slice(0, 19)
    });
    const txns = srsRes.transactions || [];
    for (const tx of txns) {
      const hasReceipt = Boolean(String(tx.receiptNr || '').trim());
      const hasOrderNr = Boolean(String(tx.orderNr || '').trim());
      /* Pure POS = receipt zonder ordernr (geen weborder) */
      if (!hasReceipt || hasOrderNr) continue;
      const ts = new Date(tx.dateTime || tx.date || 0);
      const total = Number(tx.total || 0);
      /* Bruto/refund per item — zie revenue-srs.js voor toelichting:
         SRS Charged is NEGATIEF voor retour-lijnen. Split daarom op
         item-niveau zodat gemengde bonnen (verkoop + retour) kloppen. */
      let txGross = 0;
      let txRefund = 0;
      (tx.items || []).forEach((it) => {
        const charged = Number(it.charged || 0);
        if (charged >= 0) txGross += charged;
        else txRefund += Math.abs(charged);
      });

      if (ts >= today) {
        storeOrders++;
        storeRevenue += total;
        storeGross += txGross;
        storeRefunded += txRefund;
      } else if (ts >= yesterday) {
        storeOrdersY++;
        storeRevenueY += total;
        storeGrossY += txGross;
        storeRefundedY += txRefund;
      }
    }
  } catch (e) { srsError = e.message || 'SRS fetch failed'; }

  /* Combineer voor de KPI "totale omzet" */
  const webshopNet = webshopRevenue - webshopRefunded - webshopCancelled;
  const webshopNetY = webshopRevenueY - webshopRefundedY - webshopCancelledY;
  const revenue = storeRevenue + webshopNet;
  const yesterdayRevenue = storeRevenueY + webshopNetY;
  const newOrders = webshopOrders;          /* "nieuwe orders" blijft = web-orders (kassa heeft geen 'order' concept) */
  const yesterdayOrders = webshopOrdersY;

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
    shopifyDomain,
    apiVersion,
    message: configured
      ? (shopifyError ? `Shopify fout: ${shopifyError}` : '')
      : (!shopifyToken
          ? 'SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel env-vars.'
          : 'SHOPIFY_STORE_DOMAIN ontbreekt in Vercel env-vars.'),
    metrics: {
      newOrders: { value: newOrders, prev: yesterdayOrders, trendPct: trend(newOrders, yesterdayOrders) },
      revenue:   { value: Number(revenue.toFixed(2)), prev: Number(yesterdayRevenue.toFixed(2)), trendPct: trend(revenue, yesterdayRevenue) },
      storeRevenue:   {
        value: Number(storeRevenue.toFixed(2)),
        prev: Number(storeRevenueY.toFixed(2)),
        trendPct: trend(storeRevenue, storeRevenueY),
        orders: storeOrders,
        gross: Number(storeGross.toFixed(2)),
        refunded: Number(storeRefunded.toFixed(2))
      },
      webshopRevenue: { value: Number(webshopNet.toFixed(2)), prev: Number(webshopNetY.toFixed(2)), trendPct: trend(webshopNet, webshopNetY), orders: webshopOrders, refunded: Number(webshopRefunded.toFixed(2)), cancelled: Number(webshopCancelled.toFixed(2)) },
      newCustomers: { value: newCustomers, prev: null, trendPct: null },
      refunds:   { value: refunds, prev: null, trendPct: null }
    },
    srsError
  });
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
