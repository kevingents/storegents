import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getSrsReturnLogs } from '../../../lib/srs-return-log-store.js';
import { findShopifyCustomerByEmail } from '../../../lib/shopify-gift-card-client.js';

/**
 * GET/POST /api/admin/return-logs/auto-link
 *
 * Voor 'orphan' retour-records (geen orderNr) — probeert de juiste Shopify
 * order te vinden door:
 *   1. Klant op email zoeken
 *   2. Klant-orders ophalen
 *   3. Match op bedrag (binnen €0.01) + datum (order vóór retour)
 *
 * Modes:
 *   GET ?all=1               → alle orphans + suggesties (preview)
 *   GET ?logId=XXX           → alleen 1 log
 *   POST { logId, all }      → zelfde, voor latere apply
 *
 * Response per orphan:
 *   {
 *     logId, createdAt, customerEmail, customerName, refundAmount,
 *     suggestions: [
 *       { orderName, orderId, total, createdAt, confidence: 'exact|amount|fallback' }
 *     ]
 *   }
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

function clean(v) { return String(v || '').trim(); }
function moneyEq(a, b) { return Math.abs(Number(a || 0) - Number(b || 0)) < 0.01; }

async function fetchShopifyOrdersForCustomer(customerId) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN || !customerId) return [];
  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/customers/${encodeURIComponent(customerId)}/orders.json?status=any&limit=50&fields=id,name,order_number,created_at,total_price,subtotal_price,line_items,financial_status,fulfillment_status`;
  const r = await fetch(url, { headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, Accept: 'application/json' } });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`Shopify API ${r.status} — ${text.slice(0, 100)}`);
  }
  const d = await r.json();
  return d.orders || [];
}

function calculateRefundAmount(log) {
  /* refundAmount is leading, anders items.amount × quantity, anders totaalbedrag */
  if (log.refundAmount && Number(log.refundAmount) > 0) return Number(log.refundAmount);
  const items = Array.isArray(log.items) ? log.items : [];
  let sum = 0;
  for (const it of items) {
    const price = Number(it.amount || it.price || 0);
    const qty = Number(it.quantity || it.pieces || 1);
    sum += price * qty;
  }
  return Math.round(sum * 100) / 100;
}

function scoreMatch(log, order, retourTime) {
  const refundAmount = calculateRefundAmount(log);
  const orderTotal = Number(order.total_price || 0);
  const orderSubtotal = Number(order.subtotal_price || 0);
  const orderCreated = new Date(order.created_at).getTime();

  /* Order moet vóór de retour zijn aangemaakt */
  if (orderCreated > retourTime) return { confidence: 'none', score: 0 };

  /* Exact match op total of subtotal */
  if (moneyEq(refundAmount, orderTotal) || moneyEq(refundAmount, orderSubtotal)) {
    return { confidence: 'exact-amount', score: 100 };
  }

  /* Match op één regel van de order (line item amount × quantity) */
  const lineMatch = (order.line_items || []).some((li) => {
    const lineTotal = Number(li.price || 0) * Number(li.quantity || 1);
    return moneyEq(refundAmount, lineTotal);
  });
  if (lineMatch) return { confidence: 'line-amount', score: 85 };

  /* Geen exact match maar wel dezelfde klant — fallback met lage confidence */
  return { confidence: 'customer-only', score: 30 };
}

async function findSuggestions(log) {
  const email = clean(log.customerEmail).toLowerCase();
  if (!email) {
    return { logId: log.id, customerEmail: '', error: 'Geen klant-email beschikbaar' };
  }

  let customer;
  try {
    customer = await findShopifyCustomerByEmail(email);
  } catch (error) {
    return { logId: log.id, customerEmail: email, error: `Shopify customer lookup: ${error.message}` };
  }
  if (!customer?.id) {
    return { logId: log.id, customerEmail: email, error: 'Geen Shopify-klant gevonden voor dit email' };
  }

  let orders = [];
  try {
    orders = await fetchShopifyOrdersForCustomer(customer.id);
  } catch (error) {
    return { logId: log.id, customerEmail: email, error: `Orders ophalen: ${error.message}` };
  }

  const retourTime = log.createdAt ? new Date(log.createdAt).getTime() : Date.now();
  const refundAmount = calculateRefundAmount(log);

  const suggestions = orders
    .map((order) => {
      const score = scoreMatch(log, order, retourTime);
      return {
        orderName: clean(order.name).replace(/^#/, ''),
        orderId: String(order.id),
        orderNumber: String(order.order_number || ''),
        total: Number(order.total_price || 0),
        createdAt: order.created_at,
        financialStatus: order.financial_status,
        fulfillmentStatus: order.fulfillment_status,
        lineItemsCount: (order.line_items || []).length,
        confidence: score.confidence,
        score: score.score
      };
    })
    .filter((s) => s.confidence !== 'none')
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  return {
    logId: log.id,
    customerEmail: email,
    customerName: clean(log.customerName),
    refundAmount,
    retourCreatedAt: log.createdAt,
    suggestions,
    bestMatch: suggestions[0] || null
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
  }
  if (requireAdmin(req, res)) return;

  const body = req.body || {};
  const logId = String(req.query.logId || body.logId || '').trim();
  const wantAll = String(req.query.all || body.all || '') === '1' || String(req.query.all || body.all || '').toLowerCase() === 'true';

  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    return res.status(200).json({
      success: false,
      configured: false,
      message: 'SHOPIFY_ADMIN_ACCESS_TOKEN of SHOPIFY_STORE_DOMAIN ontbreekt in Vercel env.'
    });
  }

  try {
    const allLogs = await getSrsReturnLogs();

    /* Filter orphans: geen orderNr én geen shopifyOrderId */
    const orphans = allLogs.filter((l) => !clean(l.orderNr) && !clean(l.shopifyOrderId));

    if (logId) {
      const log = allLogs.find((l) => String(l.id) === logId);
      if (!log) return res.status(404).json({ success: false, message: `Retour-log ${logId} niet gevonden.` });
      const result = await findSuggestions(log);
      return res.status(200).json({ success: true, ...result });
    }

    if (wantAll) {
      const results = [];
      for (const log of orphans.slice(0, 50)) { /* limit om Shopify niet te overbelasten */
        const r = await findSuggestions(log);
        results.push(r);
      }
      return res.status(200).json({
        success: true,
        orphanCount: orphans.length,
        analyzed: results.length,
        results
      });
    }

    /* Default: alleen tellen + 1 voorbeeld */
    return res.status(200).json({
      success: true,
      orphanCount: orphans.length,
      sampleLogIds: orphans.slice(0, 5).map((l) => l.id),
      hint: 'Geef ?logId=X voor 1 specifieke log, of ?all=1 voor max 50.'
    });
  } catch (error) {
    console.error('[return-logs/auto-link] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Auto-link mislukt.' });
  }
}
