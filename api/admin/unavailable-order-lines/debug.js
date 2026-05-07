import { listUnavailableOrderLines } from '../../../lib/unavailable-order-line-service.js';
import { findShopifyOrderByName } from '../../../lib/shopify-unavailable-refund-client.js';

function clean(value) { return String(value || '').trim(); }
function normalizeStatus(value) { return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '); }

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization || req.query.adminToken || req.query.admin_token || '').replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function baseCancellationId(value) { return clean(value).split('::')[0] || clean(value); }
function sameRow(row = {}, id = '') {
  const cleanId = clean(id);
  const baseId = baseCancellationId(cleanId);
  return row.id === cleanId || row.cancellationId === cleanId || row.cancellationId === baseId || cleanId.startsWith(`${row.cancellationId}::`);
}
function norm(value) { return clean(value).toLowerCase(); }
function digits(value) { return String(value || '').replace(/\D+/g, ''); }

function collectLineValues(line = {}) {
  const values = [line.sku, line.title, line.variant_title, line.name, line.vendor, line.product_id, line.variant_id, line.barcode];
  if (Array.isArray(line.properties)) line.properties.forEach((property) => values.push(property.name, property.value));
  return values.map(norm).filter(Boolean);
}

function itemNeedles(row = {}) {
  return [row.sku, row.barcode, row.title, row.articleNumber, row.articleId, row.orderLineNr].map(norm).filter(Boolean);
}

function lineMatches(line = {}, row = {}) {
  const needles = itemNeedles(row);
  const values = collectLineValues(line);
  const lineSku = norm(line.sku);
  const direct = Boolean(lineSku && needles.includes(lineSku)) || needles.some((needle) => values.includes(needle));
  const digitNeedles = needles.map(digits).filter((value) => value.length >= 6);
  const digitValues = values.map(digits).filter((value) => value.length >= 6);
  const digit = digitNeedles.some((needle) => digitValues.some((value) => value === needle || value.includes(needle) || needle.includes(value)));
  return { matched: direct || digit, direct, digit, needles, values, digitNeedles, digitValues };
}

function lineDebug(line = {}, row = {}) {
  const match = lineMatches(line, row);
  return {
    matched: match.matched,
    match,
    id: line.id,
    title: line.title,
    name: line.name,
    sku: line.sku,
    barcode: line.barcode,
    variantTitle: line.variant_title,
    quantity: line.quantity,
    price: line.price,
    discountedPrice: line.discounted_price,
    productId: line.product_id,
    variantId: line.variant_id
  };
}

function publicRow(row = {}) {
  return {
    id: row.id,
    cancellationId: row.cancellationId,
    lineIndex: row.lineIndex,
    orderNr: row.orderNr,
    store: row.store,
    lastResponsibleStore: row.lastResponsibleStore,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    amount: row.amount,
    quantity: row.quantity,
    fulfillmentId: row.fulfillmentId,
    orderLineNr: row.orderLineNr,
    sku: row.sku,
    barcode: row.barcode,
    articleNumber: row.articleNumber,
    articleId: row.articleId,
    title: row.title,
    srsLineStatus: row.srsLineStatus,
    srsStatus: row.srsStatus,
    srsSourceStatus: row.srsSourceStatus,
    source: row.source,
    status: row.status,
    refundStatus: row.refundStatus,
    srsCancelStatus: row.srsCancelStatus,
    mailStatus: row.mailStatus,
    error: row.error,
    isUnavailableLike: normalizeStatus([row.srsLineStatus, row.srsStatus, row.reason, row.srsSourceStatus, row.source].filter(Boolean).join(' ')).includes('unavailable') || normalizeStatus(row.reason).includes('niet leverbaar')
  };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const id = clean(req.query.id || req.query.lineId || '');
    const orderNr = clean(req.query.orderNr || req.query.order || '');
    const sku = clean(req.query.sku || req.query.barcode || '');
    const { rows, totals } = await listUnavailableOrderLines({ status: 'all' });

    let candidates = rows;
    if (id) candidates = candidates.filter((row) => sameRow(row, id));
    if (orderNr) candidates = candidates.filter((row) => clean(row.orderNr).replace(/^#/, '') === orderNr.replace(/^#/, ''));
    if (sku) candidates = candidates.filter((row) => clean(row.sku) === sku || clean(row.barcode) === sku || clean(row.articleNumber) === sku);

    const row = candidates[0] || null;
    let shopify = null;

    if (row?.orderNr) {
      try {
        const order = await findShopifyOrderByName(row.orderNr);
        const lineItems = (order.line_items || []).map((line) => lineDebug(line, row));
        shopify = {
          foundOrder: true,
          orderId: order.id,
          orderName: order.name,
          currency: order.currency,
          financialStatus: order.financial_status,
          fulfillmentStatus: order.fulfillment_status,
          tags: order.tags,
          lineItems,
          matchedLineItems: lineItems.filter((line) => line.matched)
        };
      } catch (error) {
        shopify = { foundOrder: false, error: error.message, data: error.data || null };
      }
    }

    return res.status(200).json({
      success: true,
      mode: 'unavailable_order_line_debug',
      input: { id, orderNr, sku },
      totals,
      rowsTotal: rows.length,
      candidatesTotal: candidates.length,
      candidates: candidates.slice(0, 10).map(publicRow),
      selectedRow: row ? publicRow(row) : null,
      shopify,
      nextSteps: row
        ? ['Controleer selectedRow.id/cancellationId', 'Controleer shopify.matchedLineItems', 'Als matchedLineItems leeg is, matching probleem', 'Als bedrag selectedRow 0 maar Shopify line price gevuld is, verrijking/refundpad testen']
        : ['Geen opgeslagen niet-leverbare regel gevonden voor deze filters. Gebruik eerst Order zoeken in SRS of SRS sync nu, of controleer het ordernummer.']
    });
  } catch (error) {
    console.error('[admin/unavailable-order-lines/debug]', error);
    return res.status(500).json({ success: false, message: error.message || 'Debug mislukt.' });
  }
}
