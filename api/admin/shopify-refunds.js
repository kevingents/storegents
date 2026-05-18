import { handleCors, setCorsHeaders } from '../../lib/cors.js';

/**
 * GET /api/admin/shopify-refunds
 *
 * Haalt alle Shopify refunds op (online retouren / refunds via webshop / klantenservice).
 * Bron: Shopify Admin GraphQL — orders met refunds in periode.
 *
 * Filters:
 *   - dateFrom, dateTo: ISO datum (default: laatste 90 dagen)
 *   - limit: max aantal orders te scannen (default 250)
 *
 * Response:
 *   { success, totals, rows: [...] }
 *
 * Elke rij = 1 refund-line (orderregel niveau).
 */

const SHOPIFY_STORE_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || '';
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

async function shopifyGraphql(query, variables = {}) {
  if (!SHOPIFY_STORE_DOMAIN || !SHOPIFY_TOKEN) {
    throw new Error('SHOPIFY_STORE_DOMAIN en/of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreken.');
  }
  const shop = SHOPIFY_STORE_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_TOKEN
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { message: text }; }
  if (!res.ok) throw new Error(`Shopify ${res.status}: ${data.errors ? JSON.stringify(data.errors) : text.slice(0, 300)}`);
  if (data.errors) throw new Error(`Shopify GraphQL: ${JSON.stringify(data.errors)}`);
  return data.data;
}

/* Detecteer of een refund is via "in-winkel" gateway (POS) of online (web checkout) */
function detectChannel(refund, order) {
  const gateways = (order.paymentGatewayNames || []).join(' ').toLowerCase();
  const sourceName = String(order.sourceName || '').toLowerCase();
  const refundGateway = String(refund.gateway || '').toLowerCase();

  if (sourceName.includes('pos') || gateways.includes('shopify_payments_pos') || refundGateway.includes('pos')) {
    return 'store_pos';
  }
  if (sourceName.includes('web') || gateways.includes('shopify_payments')) {
    return 'online';
  }
  return 'unknown';
}

async function fetchRefundsForPeriod({ dateFrom, dateTo, limit }) {
  /* GraphQL — orders met refunds in periode, geneste refundLineItems voor orderregel-detail */
  const query = `
    query ($q: String!, $first: Int!, $cursor: String) {
      orders(query: $q, first: $first, after: $cursor, sortKey: UPDATED_AT, reverse: true) {
        edges {
          cursor
          node {
            id
            name
            createdAt
            updatedAt
            sourceName
            paymentGatewayNames
            customer { firstName lastName email }
            refunds {
              id
              createdAt
              note
              totalRefundedSet { shopMoney { amount currencyCode } }
              refundLineItems(first: 50) {
                edges {
                  node {
                    quantity
                    subtotalSet { shopMoney { amount currencyCode } }
                    lineItem {
                      id
                      sku
                      title
                      variant { id title }
                    }
                  }
                }
              }
              transactions(first: 5) {
                edges { node { gateway kind status } }
              }
            }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  `;

  const qParts = [`updated_at:>=${dateFrom}`];
  if (dateTo) qParts.push(`updated_at:<=${dateTo}`);
  qParts.push('financial_status:partially_refunded OR financial_status:refunded');

  let cursor = null;
  let scanned = 0;
  const rows = [];
  const maxOrders = Math.min(2000, limit);

  while (scanned < maxOrders) {
    const pageSize = Math.min(50, maxOrders - scanned);
    const data = await shopifyGraphql(query, { q: qParts.join(' AND '), first: pageSize, cursor });
    const edges = data.orders?.edges || [];
    if (!edges.length) break;

    for (const orderEdge of edges) {
      const order = orderEdge.node;
      const refunds = order.refunds || [];
      for (const refund of refunds) {
        const channel = detectChannel({ ...refund, gateway: (refund.transactions?.edges?.[0]?.node?.gateway || '') }, order);
        const lineEdges = refund.refundLineItems?.edges || [];

        if (!lineEdges.length) {
          rows.push({
            id: `${refund.id}::header`,
            refundId: refund.id,
            createdAt: refund.createdAt,
            orderNr: clean(order.name).replace(/^#/, ''),
            shopifyOrderId: clean(order.id).split('/').pop(),
            customerName: clean([order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ')),
            customerEmail: clean(order.customer?.email),
            sku: '', title: '(refund zonder lineitem-detail)',
            quantity: 0,
            amount: moneyNumber(refund.totalRefundedSet?.shopMoney?.amount),
            currency: refund.totalRefundedSet?.shopMoney?.currencyCode || 'EUR',
            channel,
            source: 'shopify_refund',
            note: refund.note || ''
          });
          continue;
        }

        for (const le of lineEdges) {
          const node = le.node;
          const li = node.lineItem || {};
          rows.push({
            id: `${refund.id}::${li.id || ''}`,
            refundId: refund.id,
            createdAt: refund.createdAt,
            orderNr: clean(order.name).replace(/^#/, ''),
            shopifyOrderId: clean(order.id).split('/').pop(),
            customerName: clean([order.customer?.firstName, order.customer?.lastName].filter(Boolean).join(' ')),
            customerEmail: clean(order.customer?.email),
            sku: clean(li.sku || ''),
            title: clean(li.title || ''),
            variantTitle: clean(li.variant?.title || ''),
            quantity: Number(node.quantity || 1),
            amount: moneyNumber(node.subtotalSet?.shopMoney?.amount),
            currency: node.subtotalSet?.shopMoney?.currencyCode || 'EUR',
            channel,
            source: 'shopify_refund',
            note: refund.note || ''
          });
        }
      }
      scanned += 1;
    }

    if (!data.orders.pageInfo.hasNextPage) break;
    cursor = data.orders.pageInfo.endCursor;
  }

  return { rows, scanned };
}

function computeTotals(rows) {
  const totals = {
    total: rows.length,
    amount: 0,
    onlineCount: 0,
    onlineAmount: 0,
    storePosCount: 0,
    storePosAmount: 0,
    unknownCount: 0,
    uniqueOrders: new Set()
  };

  for (const row of rows) {
    totals.amount += Number(row.amount || 0);
    if (row.channel === 'online') { totals.onlineCount += 1; totals.onlineAmount += Number(row.amount || 0); }
    else if (row.channel === 'store_pos') { totals.storePosCount += 1; totals.storePosAmount += Number(row.amount || 0); }
    else totals.unknownCount += 1;
    if (row.orderNr) totals.uniqueOrders.add(row.orderNr);
  }

  return {
    total: totals.total,
    amount: moneyNumber(totals.amount),
    onlineCount: totals.onlineCount,
    onlineAmount: moneyNumber(totals.onlineAmount),
    storePosCount: totals.storePosCount,
    storePosAmount: moneyNumber(totals.storePosAmount),
    unknownCount: totals.unknownCount,
    uniqueOrders: totals.uniqueOrders.size
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const limit = Math.max(10, Math.min(2000, Number(req.query.limit || 250)));
    const defaultFrom = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const dateFrom = clean(req.query.dateFrom || req.query.from || defaultFrom);
    const dateTo = clean(req.query.dateTo || req.query.to || '');

    const result = await fetchRefundsForPeriod({ dateFrom, dateTo, limit });

    return res.status(200).json({
      success: true,
      mode: 'shopify_refunds',
      note: 'Bron: Shopify GraphQL — orders met refunds. Kanaal-detectie via sourceName + paymentGatewayNames. POS = in winkel, web = online.',
      dateFrom,
      dateTo,
      ordersScanned: result.scanned,
      totals: computeTotals(result.rows),
      rows: result.rows
    });
  } catch (error) {
    console.error('[admin/shopify-refunds]', error);
    return res.status(200).json({ success: false, configured: false, message: error.message || 'Shopify refunds konden niet worden opgehaald.' });
  }
}
