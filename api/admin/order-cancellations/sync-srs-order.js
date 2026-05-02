import { getSrsFulfillments } from '../../../lib/srs-client.js';
import { getWebordersWithDetails } from '../../../lib/srs-weborders-message-client.js';
import { addOrderCancellation } from '../../../lib/order-cancellation-store.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

const VALID_STATUSES = new Set(['unavailable', 'cancelled', 'canceled']);

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_error) { return {}; }
  }
  return req.body || {};
}

function cleanOrderNr(value) {
  return String(value || '').replace(/^#/, '').trim();
}

function normalizeStatus(value) {
  const status = String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
  if (['niet leverbaar', 'not available'].includes(status)) return 'unavailable';
  if (['geannuleerd', 'annulled'].includes(status)) return 'cancelled';
  return status;
}

function statusReason(value) {
  const status = normalizeStatus(value);
  if (status === 'unavailable') return 'Niet leverbaar volgens SRS';
  if (status === 'cancelled' || status === 'canceled') return 'Geannuleerd volgens SRS';
  return 'SRS orderregel status';
}

function monthKey(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7);
  return date.toISOString().slice(0, 7);
}

function parseNumber(value, fallback = 0) {
  const number = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(number) ? number : fallback;
}

function detailLineForFulfillment(detail, fulfillment) {
  const sku = String(fulfillment.sku || '').trim();
  const orderLineNr = String(fulfillment.orderLineNr || '').trim();
  const lines = Array.isArray(detail?.items) ? detail.items : [];

  return lines.find((line) => orderLineNr && String(line.orderLineNr || '').trim() === orderLineNr) ||
    lines.find((line) => sku && String(line.sku || line.barcode || '').trim() === sku) ||
    null;
}

async function getOrderDetails(orderNr) {
  try {
    const result = await getWebordersWithDetails(orderNr);
    return result.detailsByOrder?.get(orderNr) || null;
  } catch (error) {
    console.warn('sync-srs-order: GetWebordersWithDetails failed', orderNr, error.message);
    return null;
  }
}

function buildRecord({ orderNr, fulfillment, detail, store, employeeName }) {
  const line = detailLineForFulfillment(detail, fulfillment);
  const status = normalizeStatus(fulfillment.status);
  const createdAt = fulfillment.updatedAt || fulfillment.createdAt || new Date().toISOString();
  const quantity = parseNumber(line?.pieces || line?.quantity || fulfillment.quantity || fulfillment.pieces, 1);
  const unitAmount = parseNumber(line?.price || fulfillment.productPrice || fulfillment.price, 0);
  const amount = Math.max(0, quantity * unitAmount);
  const sku = fulfillment.sku || line?.sku || line?.barcode || '';

  const item = {
    fulfillmentId: String(fulfillment.fulfillmentId || '').trim(),
    orderLineNr: String(line?.orderLineNr || fulfillment.orderLineNr || '').trim(),
    articleNumber: String(fulfillment.articleNumber || line?.articleNumber || sku || '').trim(),
    articleId: String(fulfillment.articleId || line?.articleId || '').trim(),
    sku: String(sku || '').trim(),
    barcode: String(line?.barcode || sku || '').trim(),
    title: String(fulfillment.productName || line?.title || line?.productName || sku || '').trim(),
    color: String(fulfillment.color || line?.color || line?.kleur || '').trim(),
    size: String(fulfillment.size || line?.size || line?.maat || '').trim(),
    currentBranch: String(fulfillment.currentBranch || fulfillment.currentBranchName || fulfillment.branchId || '').trim(),
    branchId: String(fulfillment.branchId || '').trim(),
    quantity,
    amount,
    srsStatus: status
  };

  return {
    idempotencyKey: [
      'srs-order-direct-sync',
      orderNr,
      item.fulfillmentId,
      item.orderLineNr,
      item.sku,
      status
    ].filter(Boolean).join('::'),
    createdAt,
    updatedAt: new Date().toISOString(),
    month: monthKey(createdAt),
    store: store || (item.branchId ? `Filiaal ${item.branchId}` : 'SRS zonder filiaal'),
    employeeName: employeeName || 'SRS order sync',
    orderNr,
    type: 'partial',
    reason: statusReason(status),
    customerEmail: detail?.customerEmail || '',
    customerName: detail?.customerName || fulfillment.customerName || '',
    amount,
    currency: 'EUR',
    items: [item],
    status: 'completed',
    srsStatus: status === 'unavailable' ? 'unavailable_in_srs' : 'cancelled_in_srs',
    refundStatus: 'pending',
    mailStatus: 'pending',
    source: 'srs_get_fulfillments_order_nr_direct_sync',
    srsSourceStatus: status,
    srsResult: {
      source: 'srs_get_fulfillments_order_nr_direct_sync',
      detectedStatus: status,
      fulfillmentId: item.fulfillmentId,
      orderLineNr: item.orderLineNr,
      branchId: item.branchId,
      syncedAt: new Date().toISOString()
    }
  };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!requireAdmin(req, res)) return;

  const body = parseBody(req);
  const orderNr = cleanOrderNr(req.query.orderNr || req.query.order || body.orderNr || body.order);
  const dryRun = String(req.query.dryRun || body.dryRun || '').toLowerCase() === 'true';
  const employeeName = String(req.query.employeeName || body.employeeName || '').trim();
  const store = String(req.query.store || body.store || '').trim();

  if (!orderNr) {
    return res.status(400).json({ success: false, message: 'SRS orderNr ontbreekt.' });
  }

  try {
    const [fulfillmentResult, detail] = await Promise.all([
      getSrsFulfillments(orderNr),
      getOrderDetails(orderNr)
    ]);

    const fulfillments = fulfillmentResult.fulfillments || [];
    const targetRows = fulfillments.filter((row) => VALID_STATUSES.has(normalizeStatus(row.status)));
    const records = targetRows.map((fulfillment) => buildRecord({ orderNr, fulfillment, detail, store, employeeName }));

    let created = 0;
    let duplicates = 0;

    if (!dryRun) {
      for (const record of records) {
        const result = await addOrderCancellation(record);
        if (result.duplicate) duplicates += 1;
        else created += 1;
      }
    }

    return res.status(200).json({
      success: true,
      dryRun,
      orderNr,
      scanned: fulfillments.length,
      found: targetRows.length,
      created: dryRun ? 0 : created,
      duplicates: dryRun ? 0 : duplicates,
      statuses: ['unavailable', 'cancelled'],
      preview: dryRun ? records : records.slice(0, 25),
      message: dryRun
        ? `Dry-run klaar. ${targetRows.length} niet-leverbare/geannuleerde SRS orderregel(s) gevonden voor order ${orderNr}.`
        : `Synchronisatie klaar. ${created} nieuw, ${duplicates} al bekend voor order ${orderNr}.`
    });
  } catch (error) {
    console.error('SRS order direct sync error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'SRS orderregel sync kon niet worden uitgevoerd.',
      details: error.fault || error.data || null
    });
  }
}
