import { getFulfillments, getWebordersWithDetails, isSrsCancelledStatus } from '../../../lib/srs-weborders-message-client.js';
import { getShopifyOrderLineContext } from '../../../lib/shopify-order-line-context-client.js';
import { addOrderCancellationsBulk } from '../../../lib/order-cancellation-bulk-store.js';

const CANCELLED_STATUSES = ['cancelled'];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function clean(value) {
  return String(value || '').trim();
}

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
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

function truthy(value) {
  return ['1', 'true', 'yes', 'ja'].includes(clean(value).toLowerCase());
}

function money(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function inDateRange(value, dateFrom, dateTo) {
  const date = safeDate(value);
  if (!date) return true;
  const from = safeDate(dateFrom);
  const to = safeDate(dateTo);
  const toExclusive = to ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : null;
  if (from && date < from) return false;
  if (toExclusive && date >= toExclusive) return false;
  return true;
}

function lineDate(row = {}) {
  return row.updatedAt || row.createdAt || row.date || row.orderDate || row.deliveryDate || new Date().toISOString();
}

function monthKey(value) {
  const date = safeDate(value);
  return date ? date.toISOString().slice(0, 7) : new Date().toISOString().slice(0, 7);
}

function srsUnavailableNow(errors = []) {
  return errors.some((error) => {
    const message = clean(error.message).toLowerCase();
    return error.source === 'get_fulfillments' ||
      message.includes('limit reached') ||
      message.includes('rate limit') ||
      message.includes('timeout') ||
      message.includes('temporarily');
  });
}

async function getDetail(orderNr, cache, errors, includeDetails) {
  if (!includeDetails) return null;
  const cleanOrderNr = clean(orderNr).replace(/^#/, '');
  if (!cleanOrderNr) return null;
  if (cache.has(cleanOrderNr)) return cache.get(cleanOrderNr);
  try {
    const result = await getWebordersWithDetails(cleanOrderNr);
    const detail = result.detailsByOrder?.get(cleanOrderNr) || null;
    cache.set(cleanOrderNr, detail);
    return detail;
  } catch (error) {
    errors.push({ orderNr: cleanOrderNr, source: 'srs_detail', message: error.message || String(error) });
    cache.set(cleanOrderNr, null);
    return null;
  }
}

function findDetailLine(detail, fulfillment) {
  const sku = clean(fulfillment.sku || fulfillment.barcode).toLowerCase();
  const orderLineNr = clean(fulfillment.orderLineNr);
  const lines = Array.isArray(detail?.items) ? detail.items : [];
  return lines.find((line) => orderLineNr && clean(line.orderLineNr) === orderLineNr) ||
    lines.find((line) => sku && clean(line.sku || line.barcode).toLowerCase() === sku) ||
    null;
}

async function getShopifyContext(orderNr, item, cache, errors) {
  const cacheKey = [clean(orderNr).replace(/^#/, ''), item.sku || item.barcode || item.articleNumber || item.orderLineNr || ''].join('::');
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  try {
    const context = await getShopifyOrderLineContext({ orderNr, item, quantity: item.quantity || 1 });
    cache.set(cacheKey, context);
    return context;
  } catch (error) {
    errors.push({ orderNr: clean(orderNr).replace(/^#/, ''), sku: item.sku || item.barcode || '', source: 'shopify_context', message: error.message || String(error) });
    cache.set(cacheKey, null);
    return null;
  }
}

function buildRecord({ fulfillment, detail, detailLine, shopifyContext }) {
  const orderNr = clean(fulfillment.orderNr).replace(/^#/, '');
  const date = lineDate(fulfillment);
  const quantity = Number(detailLine?.pieces || detailLine?.quantity || fulfillment.quantity || fulfillment.pieces || shopifyContext?.quantity || 1);
  const srsUnit = Number(String(detailLine?.price || fulfillment.price || fulfillment.productPrice || 0).replace(',', '.')) || 0;
  const shopifyAmount = Number(shopifyContext?.amount || 0);
  const amount = money(shopifyAmount > 0 ? shopifyAmount : quantity * srsUnit);
  const sku = clean(fulfillment.sku || fulfillment.barcode || detailLine?.sku || detailLine?.barcode || shopifyContext?.sku);
  const barcode = clean(fulfillment.barcode || fulfillment.sku || detailLine?.barcode || detailLine?.sku || shopifyContext?.sku);
  const fulfillmentId = clean(fulfillment.fulfillmentId || fulfillment.id);
  const orderLineNr = clean(fulfillment.orderLineNr || detailLine?.orderLineNr);
  const store = clean(shopifyContext?.fulfillmentLocation || shopifyContext?.store || fulfillment.fulfillmentStore || fulfillment.fulfilmentStore || 'SRS zonder filiaal');

  const item = {
    fulfillmentId,
    orderLineNr,
    articleNumber: clean(fulfillment.articleNumber || fulfillment.artikelnummer || sku),
    articleId: clean(fulfillment.articleId || fulfillment.artikelId || ''),
    sku,
    barcode,
    title: clean(fulfillment.productName || detailLine?.title || detailLine?.productName || shopifyContext?.title || sku || barcode),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    amount,
    srsStatus: clean(fulfillment.status || 'cancelled'),
    branchId: clean(fulfillment.branchId || fulfillment.fulfilmentBranchId || fulfillment.fulfillmentBranchId || ''),
    currentBranch: clean(fulfillment.branchId || fulfillment.fulfilmentBranchId || fulfillment.fulfillmentBranchId || ''),
    originBranch: clean(fulfillment.branchId || fulfillment.fulfilmentBranchId || fulfillment.fulfillmentBranchId || ''),
    lastResponsibleStore: store,
    srsUnavailableStore: store,
    shopifyFulfillmentLocation: clean(shopifyContext?.fulfillmentLocation || shopifyContext?.store),
    shopifyLineItemId: clean(shopifyContext?.lineItemId)
  };

  return {
    idempotencyKey: ['srs-cancelled-2026-backfill', orderNr, fulfillmentId, orderLineNr, item.articleNumber, barcode].join('::'),
    createdAt: date,
    updatedAt: new Date().toISOString(),
    processedAt: new Date().toISOString(),
    month: monthKey(date),
    store,
    employeeName: 'SRS 2026 geannuleerd backfill',
    orderNr,
    shopifyOrderNr: clean(shopifyContext?.orderName || orderNr).replace(/^#/, ''),
    weborderNr: clean(shopifyContext?.orderName || orderNr).replace(/^#/, ''),
    type: 'partial',
    reason: 'SRS geannuleerd - 2026 rapportage backfill',
    customerEmail: shopifyContext?.customerEmail || detail?.customerEmail || clean(fulfillment.customerEmail),
    customerName: shopifyContext?.customerName || detail?.customerName || clean(fulfillment.customerName),
    amount,
    currency: 'EUR',
    items: [item],
    status: 'processed',
    problemType: 'niet_leverbaar',
    srsStatus: 'cancelled_in_srs',
    srsCancelStatus: 'cancelled_in_srs',
    refundStatus: 'already_refunded',
    mailStatus: 'shopify_refund_mail',
    stockReturnStatus: 'skipped_no_stock_return',
    source: 'srs_cancelled_2026_backfill',
    srsSourceStatus: clean(fulfillment.status || 'cancelled'),
    shopifyContext: shopifyContext || null,
    srsResult: {
      source: 'srs_cancelled_2026_backfill',
      detectedStatus: clean(fulfillment.status || 'cancelled'),
      fulfillmentId,
      orderLineNr,
      store,
      shopifyFulfillmentLocation: clean(shopifyContext?.fulfillmentLocation || shopifyContext?.store),
      syncedAt: new Date().toISOString(),
      stockReturnStatus: 'skipped_no_stock_return',
      orderLevelCancel: false,
      lineLevelOnly: true,
      resolvedInSrs: true
    }
  };
}

async function getCancelledFulfillments(statuses, errors) {
  const all = [];
  for (const status of statuses) {
    try {
      const result = await getFulfillments({ status });
      for (const row of result.fulfillments || []) {
        if (isSrsCancelledStatus(row.status || status)) all.push({ ...row, requestedStatus: status });
      }
    } catch (error) {
      errors.push({ status, source: 'get_fulfillments', message: error.message || String(error) });
    }
  }

  return Array.from(new Map(all.map((row) => [
    clean(row.fulfillmentId || row.id || `${row.orderNr}-${row.orderLineNr}-${row.sku || row.barcode}`),
    row
  ])).values());
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const dateFrom = clean(req.query.dateFrom || '2026-01-01');
    const dateTo = clean(req.query.dateTo || '2026-12-31');
    const maxRecords = Math.max(1, Math.min(1000, Number(req.query.maxRecords || 250)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const dryRun = truthy(req.query.dryRun);
    const includeDetails = truthy(req.query.includeDetails);
    const statuses = clean(req.query.statuses).split(/[;,]+/).map(clean).filter(Boolean);
    const selectedStatuses = statuses.length ? statuses : CANCELLED_STATUSES;
    const errors = [];
    const detailCache = new Map();
    const shopifyCache = new Map();
    const records = [];

    const fulfillments = await getCancelledFulfillments(selectedStatuses, errors);
    const eligibleFulfillments = [];
    let skippedByDate = 0;

    for (const fulfillment of fulfillments) {
      const date = lineDate(fulfillment);
      if (!inDateRange(date, dateFrom, dateTo)) {
        skippedByDate += 1;
        continue;
      }
      eligibleFulfillments.push(fulfillment);
    }

    if (!fulfillments.length && srsUnavailableNow(errors)) {
      return res.status(503).json({
        success: false,
        retryable: true,
        mode: 'backfill_cancelled_2026',
        dryRun,
        dateFrom,
        dateTo,
        offset,
        limit: maxRecords,
        nextOffset: offset,
        hasMore: true,
        includeDetails,
        statuses: selectedStatuses,
        found: 0,
        eligibleInDate: 0,
        prepared: 0,
        created: 0,
        duplicates: 0,
        skippedByDate,
        skippedByOffset: 0,
        exhausted: false,
        errors,
        preview: [],
        message: 'SRS cancelled backfill tijdelijk niet beschikbaar. Offset is niet verhoogd; probeer later opnieuw.'
      });
    }

    const selectedFulfillments = eligibleFulfillments.slice(offset, offset + maxRecords);
    const skippedByOffset = Math.min(offset, eligibleFulfillments.length);

    for (const fulfillment of selectedFulfillments) {
      const orderNr = clean(fulfillment.orderNr).replace(/^#/, '');
      const detail = await getDetail(orderNr, detailCache, errors, includeDetails);
      const detailLine = findDetailLine(detail, fulfillment);
      const item = {
        sku: clean(fulfillment.sku || fulfillment.barcode || detailLine?.sku || detailLine?.barcode),
        barcode: clean(fulfillment.barcode || fulfillment.sku || detailLine?.barcode || detailLine?.sku),
        title: clean(fulfillment.productName || detailLine?.title || detailLine?.productName),
        articleNumber: clean(fulfillment.articleNumber || fulfillment.artikelnummer || fulfillment.sku || detailLine?.sku),
        articleId: clean(fulfillment.articleId || fulfillment.artikelId || ''),
        orderLineNr: clean(fulfillment.orderLineNr || detailLine?.orderLineNr),
        quantity: Number(detailLine?.pieces || detailLine?.quantity || fulfillment.quantity || fulfillment.pieces || 1)
      };
      const shopifyContext = await getShopifyContext(orderNr, item, shopifyCache, errors);
      records.push(buildRecord({ fulfillment, detail, detailLine, shopifyContext }));
    }

    const saved = dryRun ? { created: 0, duplicates: 0, createdRecords: [], duplicateRecords: [] } : await addOrderCancellationsBulk(records);
    const nextOffset = offset + records.length;
    const hasMore = nextOffset < eligibleFulfillments.length;

    return res.status(200).json({
      success: true,
      mode: 'backfill_cancelled_2026',
      dryRun,
      dateFrom,
      dateTo,
      offset,
      limit: maxRecords,
      nextOffset,
      hasMore,
      includeDetails,
      statuses: selectedStatuses,
      found: fulfillments.length,
      eligibleInDate: eligibleFulfillments.length,
      prepared: records.length,
      created: saved.created || 0,
      duplicates: saved.duplicates || 0,
      skippedByDate,
      skippedByOffset,
      exhausted: !hasMore,
      errors,
      preview: records.slice(0, Number(req.query.previewLimit || 25)),
      message: dryRun
        ? `Dry-run klaar. ${records.length} geannuleerde SRS regel(s) voorbereid. ${eligibleFulfillments.length} binnen datumfilter. Volgende offset: ${nextOffset}.`
        : `Backfill klaar. ${saved.created || 0} nieuw opgeslagen, ${saved.duplicates || 0} al bekend. ${eligibleFulfillments.length} binnen datumfilter. Volgende offset: ${nextOffset}.`
    });
  } catch (error) {
    console.error('[backfill-cancelled-2026]', error);
    return res.status(500).json({ success: false, message: error.message || 'Backfill mislukt.' });
  }
}
