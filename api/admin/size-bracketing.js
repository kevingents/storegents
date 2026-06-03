import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/size-bracketing
 *
 * Detecteert orders waarin een klant MEERDERE maten van hetzelfde artikel kocht
 * (bracketing — klant koopt M+L, houdt 1 en retourneert de andere).
 *
 * Logica per order:
 *   - Groepeer line_items op product_id
 *   - Als 1 product_id 2+ verschillende variant_ids heeft → bracket order
 *   - Idealiter: variants verschillen op 'Size'/'Maat' optie
 *
 * Filters:
 *   - dateFrom, dateTo (default: laatste 30 dagen)
 *   - limit: max orders te scannen (default 500)
 *
 * Response: aggregate + topProducts + sampleOrders.
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return false;
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

async function fetchShopifyOrders({ dateFrom, dateTo, limit }) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel.');
  }
  const shop = SHOPIFY_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const orders = [];
  let url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${dateFrom}T00:00:00Z&created_at_max=${dateTo}T23:59:59Z&limit=250&fields=id,name,created_at,total_price,customer,line_items,refunds`;

  while (url && orders.length < limit) {
    const resp = await fetch(url, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_TOKEN,
        Accept: 'application/json'
      }
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Shopify orders.json ${resp.status} — ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    orders.push(...(data.orders || []));

    /* Paginatie via Link header (Shopify cursor-based) */
    const linkHeader = resp.headers.get('link') || resp.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return orders.slice(0, limit);
}

/**
 * Bepaalt of een order size-bracketing heeft:
 * Groepeer line_items op product_id, kijk naar variant diversity.
 * Returns null als geen bracketing, anders { brackets: [...], total }
 */
function detectBracketing(order) {
  const items = order.line_items || [];
  const byProduct = new Map();

  items.forEach((item) => {
    const productId = String(item.product_id || '');
    if (!productId) return;
    const variantId = String(item.variant_id || '');
    const cur = byProduct.get(productId) || {
      productId,
      productTitle: item.title || item.name || '',
      variants: new Map()
    };
    if (!cur.variants.has(variantId)) {
      cur.variants.set(variantId, {
        variantId,
        title: item.variant_title || '',
        sku: item.sku || '',
        quantity: 0,
        price: Number(item.price || 0)
      });
    }
    const v = cur.variants.get(variantId);
    v.quantity += Number(item.quantity || 0);
    byProduct.set(productId, cur);
  });

  const brackets = [];
  for (const [, p] of byProduct) {
    if (p.variants.size >= 2) {
      const variantList = [...p.variants.values()];
      /* Check: zijn de variants daadwerkelijk verschillende MATEN? */
      const titles = variantList.map((v) => v.title.toLowerCase());
      const allDifferent = new Set(titles).size === titles.length;
      brackets.push({
        productId: p.productId,
        productTitle: p.productTitle,
        variantCount: p.variants.size,
        variants: variantList,
        totalItems: variantList.reduce((s, v) => s + v.quantity, 0),
        totalValue: moneyNumber(variantList.reduce((s, v) => s + v.price * v.quantity, 0)),
        sizesDifferent: allDifferent
      });
    }
  }

  return brackets.length ? brackets : null;
}

function hasAnyRefund(order) {
  return Array.isArray(order.refunds) && order.refunds.length > 0;
}

function refundedLineItemIds(order) {
  const ids = new Set();
  (order.refunds || []).forEach((refund) => {
    (refund.refund_line_items || []).forEach((rli) => {
      const id = String(rli.line_item_id || rli.line_item?.id || '');
      if (id) ids.add(id);
    });
  });
  return ids;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const today = new Date();
  const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateFrom = clean(req.query.dateFrom || req.query.from || defaultFrom);
  const dateTo = clean(req.query.dateTo || req.query.to || today.toISOString().slice(0, 10));
  const limit = Math.max(50, Math.min(2000, Number(req.query.limit || 500)));

  try {
    const orders = await fetchShopifyOrders({ dateFrom, dateTo, limit });

    let totalOrders = 0;
    let bracketOrders = 0;
    let bracketOrdersWithRefund = 0;
    let totalItemsBracketed = 0;
    let totalValueBracketed = 0;
    let totalItemsRefunded = 0;
    const productMap = new Map();
    const sampleOrders = [];

    orders.forEach((order) => {
      totalOrders++;
      const brackets = detectBracketing(order);
      if (!brackets) return;

      bracketOrders++;
      const hasRefund = hasAnyRefund(order);
      const refundedIds = hasRefund ? refundedLineItemIds(order) : new Set();
      if (hasRefund) bracketOrdersWithRefund++;

      brackets.forEach((b) => {
        totalItemsBracketed += b.totalItems;
        totalValueBracketed += b.totalValue;
        const cur = productMap.get(b.productId) || {
          productId: b.productId,
          productTitle: b.productTitle,
          orderCount: 0,
          variantSpread: 0,
          totalValue: 0,
          refundCount: 0
        };
        cur.orderCount++;
        cur.variantSpread = Math.max(cur.variantSpread, b.variantCount);
        cur.totalValue += b.totalValue;
        if (hasRefund) cur.refundCount++;
        productMap.set(b.productId, cur);

        /* Tel hoeveel items van DEZE bracket terug zijn gekomen */
        (order.line_items || []).forEach((li) => {
          if (String(li.product_id) === b.productId && refundedIds.has(String(li.id))) {
            totalItemsRefunded += Number(li.quantity || 0);
          }
        });
      });

      if (sampleOrders.length < 20) {
        sampleOrders.push({
          orderNr: order.name,
          shopifyOrderId: String(order.id),
          createdAt: order.created_at,
          customerName: clean([order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(' ')),
          customerEmail: order.customer?.email || '',
          totalPrice: moneyNumber(order.total_price),
          brackets: brackets.map((b) => ({
            productTitle: b.productTitle,
            variantCount: b.variantCount,
            variants: b.variants.map((v) => ({ title: v.title, sku: v.sku, quantity: v.quantity })),
            totalValue: b.totalValue
          })),
          hasRefund
        });
      }
    });

    const topProducts = [...productMap.values()]
      .map((p) => ({
        ...p,
        totalValue: moneyNumber(p.totalValue),
        refundRate: p.orderCount ? Math.round((p.refundCount / p.orderCount) * 100) : 0
      }))
      .sort((a, b) => b.orderCount - a.orderCount)
      .slice(0, 20);

    const bracketRate = totalOrders ? Math.round((bracketOrders / totalOrders) * 1000) / 10 : 0;
    const refundCorrelation = bracketOrders ? Math.round((bracketOrdersWithRefund / bracketOrders) * 100) : 0;

    return res.status(200).json({
      success: true,
      mode: 'size_bracketing',
      dateFrom,
      dateTo,
      totals: {
        ordersScanned: totalOrders,
        bracketOrders,
        bracketRate,
        bracketOrdersWithRefund,
        refundCorrelation,
        totalItemsBracketed,
        totalItemsRefunded,
        totalValueBracketed: moneyNumber(totalValueBracketed)
      },
      topProducts,
      sampleOrders,
      note: 'Bracketing = klant koopt 2+ maten van zelfde artikel. Refund-correlation = % van bracket-orders met retour.'
    });
  } catch (error) {
    console.error('[admin/size-bracketing]', error);
    return res.status(200).json({
      success: true,
      configured: !String(error.message || '').includes('ontbreekt in Vercel'),
      error: error.message || String(error),
      message: 'Size-bracketing kon niet berekend worden.',
      totals: { ordersScanned: 0, bracketOrders: 0, bracketRate: 0 },
      topProducts: [],
      sampleOrders: []
    });
  }
}
