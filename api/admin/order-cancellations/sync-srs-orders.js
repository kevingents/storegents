import { getFulfillments, getWebordersWithDetails } from '../../../lib/srs-weborders-message-client.js';
import { addOrderCancellation } from '../../../lib/order-cancellation-store.js';
import { getStoreNameByBranchId } from '../../../lib/branch-metrics.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return true;
  return String(req.headers['x-admin-token'] || req.query.adminToken || '').trim() === ADMIN_TOKEN;
}

function cleanStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function isCancellationStatus(value) {
  const status = cleanStatus(value);
  return ['unavailable', 'niet leverbaar', 'not available', 'cancelled', 'canceled', 'geannuleerd', 'annulled'].includes(status);
}

function statusReason(value) {
  const status = cleanStatus(value);
  if (['unavailable', 'niet leverbaar', 'not available'].includes(status)) return 'Niet leverbaar volgens SRS';
  if (['cancelled', 'canceled', 'geannuleerd', 'annulled'].includes(status)) return 'Geannuleerd volgens SRS';
  return 'SRS annulering / niet leverbaar';
}

function parseNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function normalizeOrderNrs(input) {
  if (Array.isArray(input)) {
    return input.map(String).map((item) => item.replace(/^#/, '').trim()).filter(Boolean);
  }

  return String(input || '')
    .split(/[\n,; ]+/)
    .map((item) => item.replace(/^#/, '').trim())
    .filter(Boolean);
}

function detailLineForFulfillment(detail, fulfillment) {
  const sku = String(fulfillment.sku || '').trim();
  const barcode = String(fulfillment.barcode || '').trim();
  const orderLineNr = String(fulfillment.orderLineNr || '').trim();
  const lines = Array.isArray(detail?.items) ? detail.items : [];

  return lines.find((line) => orderLineNr && String(line.orderLineNr || '').trim() === orderLineNr) ||
    lines.find((line) => sku && String(line.sku || '').trim() === sku) ||
    lines.find((line) => barcode && String(line.barcode || '').trim() === barcode) ||
    null;
}

function fulfillmentDate(fulfillment) {
  return fulfillment.updatedAt || fulfillment.createdAt || fulfillment.date || fulfillment.orderDate || fulfillment.deliveryDate || '';
}

async function getDetailsForOrder(orderNr) {
  try {
    const result = await getWebordersWithDetails(orderNr);
    return result.detailsByOrder?.get(orderNr) || null;
  } catch (_error) {
    return null;
  }
}

async function syncOrder({ orderNr, dryRun }) {
  const result = await getFulfillments({ orderNr });
  const fulfillments = (result.fulfillments || []).filter((item) => isCancellationStatus(item.status));

  const detail = await getDetailsForOrder(orderNr);
  const records = [];
  let created = 0;
  let duplicates = 0;

  for (const fulfillment of fulfillments) {
    const line = detailLineForFulfillment(detail, fulfillment);
    const quantity = parseNumber(line?.pieces || line?.quantity || fulfillment.quantity || fulfillment.pieces, 1);
    const unitAmount = parseNumber(line?.price || fulfillment.productPrice || fulfillment.price, 0);
    const amount = Math.max(0, quantity * unitAmount);
    const status = fulfillment.status || 'unavailable';
    const branchId = String(fulfillment.branchId || fulfillment.fulfillmentBranchId || fulfillment.fulfilmentBranchId || '').trim();
    const store = branchId ? getStoreNameByBranchId(branchId) : 'SRS zonder filiaal';

    const item = {
      fulfillmentId: fulfillment.fulfillmentId || fulfillment.id || '',
      orderLineNr: line?.orderLineNr || fulfillment.orderLineNr || '',
      articleNumber: fulfillment.articleNumber || line?.articleNumber || fulfillment.sku || '',
      articleId: fulfillment.articleId || line?.articleId || '',
      sku: fulfillment.sku || line?.sku || '',
      barcode: fulfillment.barcode || line?.barcode || fulfillment.sku || line?.sku || '',
      title: fulfillment.productName || line?.title || line?.productName || line?.sku || fulfillment.sku || '',
      color: fulfillment.color || line?.color || '',
      size: fulfillment.size || line?.size || '',
      currentBranch: fulfillment.currentBranch || '',
      branchId,
      quantity,
      amount,
      srsStatus: status
    };

    const srsDate = fulfillmentDate(fulfillment);
    const payload = {
      idempotencyKey: ['srs-order-direct-sync', orderNr, item.fulfillmentId, item.orderLineNr, item.articleNumber, item.barcode, cleanStatus(status)].join('::'),
      createdAt: srsDate || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      month: (srsDate || new Date().toISOString()).slice(0, 7),
      store,
      employeeName: 'SRS order sync',
      orderNr,
      type: 'partial',
      reason: statusReason(status),
      customerEmail: detail?.customerEmail || '',
      customerName: detail?.customerName || fulfillment.customerName || '',
      amount,
      currency: 'EUR',
      items: [item],
      status: 'completed',
      srsStatus: cleanStatus(status).includes('cancel') || cleanStatus(status).includes('geannuleerd') ? 'cancelled_in_srs' : 'unavailable_in_srs',
      refundStatus: 'pending',
      mailStatus: 'pending',
      source: 'srs_get_fulfillments_order_nr_direct_sync',
      srsSourceStatus: status,
      srsResult: {
        source: 'srs_get_fulfillments_order_nr_direct_sync',
        detectedStatus: status,
        fulfillmentId: item.fulfillmentId,
        orderLineNr: item.orderLineNr,
        branchId,
        syncedAt: new Date().toISOString()
      }
    };

    records.push(payload);

    if (!dryRun) {
      const saved = await addOrderCancellation(payload);
      if (saved.duplicate) duplicates += 1;
      else created += 1;
    }
  }

  return {
    orderNr,
    scanned: result.fulfillments?.length || 0,
    found: records.length,
    created,
    duplicates,
    preview: dryRun ? records : []
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const body = req.method === 'POST' ? (req.body || {}) : {};
    const dryRun = String(req.query.dryRun || body.dryRun || '').toLowerCase() === 'true';
    const orderNrs = normalizeOrderNrs(req.query.orderNrs || req.query.orderNr || body.orderNrs || body.orderNr);

    if (!orderNrs.length) {
      return res.status(400).json({
        success: false,
        message: 'Geef orderNrs mee, bijvoorbeeld ?orderNrs=32547,32020 of POST { "orderNrs": ["32547"] }.'
      });
    }

    const results = [];
    const errors = [];

    for (const orderNr of Array.from(new Set(orderNrs)).slice(0, 100)) {
      try {
        results.push(await syncOrder({ orderNr, dryRun }));
      } catch (error) {
        errors.push({ orderNr, message: error.message || 'Order sync mislukt.' });
      }
    }

    return res.status(200).json({
      success: true,
      dryRun,
      source: 'srs_get_fulfillments_order_nr_direct_sync',
      scannedOrders: results.length,
      found: results.reduce((sum, item) => sum + Number(item.found || 0), 0),
      created: results.reduce((sum, item) => sum + Number(item.created || 0), 0),
      duplicates: results.reduce((sum, item) => sum + Number(item.duplicates || 0), 0),
      results,
      errors,
      message: dryRun
        ? `Dry-run klaar. ${results.reduce((sum, item) => sum + Number(item.found || 0), 0)} SRS orderregel(s) gevonden.`
        : `Order sync klaar. ${results.reduce((sum, item) => sum + Number(item.created || 0), 0)} nieuw, ${results.reduce((sum, item) => sum + Number(item.duplicates || 0), 0)} dubbel.`
    });
  } catch (error) {
    console.error('SRS direct order sync error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'SRS ordernummers konden niet worden gesynchroniseerd.'
    });
  }
}
