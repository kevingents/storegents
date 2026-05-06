import { getFulfillments, getWebordersWithDetails } from './srs-weborders-message-client.js';
import { addOrderCancellation } from './order-cancellation-store.js';
import { getStoreNameByBranchId } from './branch-metrics.js';

const DEFAULT_GLOBAL_STATUSES = 'unavailable,cancelled,canceled,geannuleerd,niet leverbaar,not available';
const DEFAULT_MAX_RUNTIME_MS = 90000;
const DEFAULT_MAX_RECORDS = 500;

function clean(value) {
  return String(value || '').trim();
}

function cleanOrderNr(value) {
  return clean(value).replace(/^#/, '');
}

function normalizeStatus(value) {
  return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function nowIso() {
  return new Date().toISOString();
}

function parseNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
}

function statusList(value) {
  return clean(value || process.env.SRS_UNAVAILABLE_SYNC_STATUSES || DEFAULT_GLOBAL_STATUSES)
    .split(/[;,]+/)
    .map((item) => clean(item))
    .filter(Boolean);
}

function isProblemStatus(value) {
  const status = normalizeStatus(value);
  return status === 'unavailable' ||
    status === 'not available' ||
    status === 'niet leverbaar' ||
    status === 'cancelled' ||
    status === 'canceled' ||
    status === 'geannuleerd' ||
    status.includes('unavailable') ||
    status.includes('not available') ||
    status.includes('niet leverbaar') ||
    status.includes('cancelled') ||
    status.includes('canceled') ||
    status.includes('geannuleerd');
}

function safeDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function dateInRange(value, { dateFrom = '', dateTo = '', month = '' } = {}) {
  const date = safeDate(value);
  if (!date) return true;

  if (month && /^\d{4}-\d{2}$/.test(String(month))) {
    return date.toISOString().slice(0, 7) === String(month);
  }

  const from = safeDate(dateFrom);
  if (from && date < from) return false;

  const to = safeDate(dateTo);
  if (to) {
    const toExclusive = new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1);
    if (date >= toExclusive) return false;
  }

  return true;
}

function monthKey(value) {
  const date = safeDate(value);
  return date ? date.toISOString().slice(0, 7) : nowIso().slice(0, 7);
}

function fulfillmentDate(row = {}) {
  return row.updatedAt || row.createdAt || row.date || row.orderDate || row.deliveryDate || '';
}

async function getOrderDetails(orderNr, cache) {
  const cleanNr = cleanOrderNr(orderNr);
  if (!cleanNr) return null;
  if (cache.has(cleanNr)) return cache.get(cleanNr);

  try {
    const result = await getWebordersWithDetails(cleanNr);
    const detail = result.detailsByOrder?.get(cleanNr) || null;
    cache.set(cleanNr, detail);
    return detail;
  } catch (error) {
    console.warn('[srs-unavailable-global-sync] GetWebordersWithDetails failed:', cleanNr, error.message);
    cache.set(cleanNr, null);
    return null;
  }
}

function detailLineForFulfillment(detail, fulfillment) {
  const sku = clean(fulfillment.sku).toLowerCase();
  const barcode = clean(fulfillment.barcode).toLowerCase();
  const orderLineNr = clean(fulfillment.orderLineNr);
  const lines = Array.isArray(detail?.items) ? detail.items : [];

  return lines.find((line) => orderLineNr && clean(line.orderLineNr) === orderLineNr) ||
    lines.find((line) => sku && clean(line.sku).toLowerCase() === sku) ||
    lines.find((line) => barcode && clean(line.barcode).toLowerCase() === barcode) ||
    null;
}

function contextStoreFromFulfillments(fulfillment, orderFulfillments = []) {
  const directBranchId = clean(fulfillment.branchId || fulfillment.fulfilmentBranchId || fulfillment.fulfillmentBranchId);
  if (directBranchId) return getStoreNameByBranchId(directBranchId);

  const orderNr = cleanOrderNr(fulfillment.orderNr);
  const candidates = (orderFulfillments || [])
    .filter((row) => cleanOrderNr(row.orderNr) === orderNr)
    .filter((row) => clean(row.branchId || row.fulfilmentBranchId || row.fulfillmentBranchId));

  const processed = candidates.find((row) => normalizeStatus(row.status) === 'processed');
  const fallback = processed || candidates[0];
  const branchId = clean(fallback?.branchId || fallback?.fulfilmentBranchId || fallback?.fulfillmentBranchId);

  return branchId ? getStoreNameByBranchId(branchId) : 'SRS zonder filiaal';
}

function makeRecord({ fulfillment, detail, line, status, orderFulfillments }) {
  const orderNr = cleanOrderNr(fulfillment.orderNr);
  const normalizedStatus = normalizeStatus(status || fulfillment.status);
  const srsDate = fulfillmentDate(fulfillment) || nowIso();
  const quantity = parseNumber(line?.pieces || line?.quantity || fulfillment.quantity || fulfillment.pieces, 1);
  const unitAmount = parseNumber(line?.price || fulfillment.productPrice || fulfillment.price, 0);
  const amount = Math.max(0, quantity * unitAmount);
  const branchId = clean(fulfillment.branchId || fulfillment.fulfilmentBranchId || fulfillment.fulfillmentBranchId);
  const store = branchId ? getStoreNameByBranchId(branchId) : contextStoreFromFulfillments(fulfillment, orderFulfillments);
  const directStore = branchId ? store : 'SRS zonder filiaal';
  const problemLabel = normalizedStatus.includes('cancel') || normalizedStatus.includes('geannuleerd') ? 'Geannuleerd volgens SRS' : 'Niet leverbaar volgens SRS';

  const item = {
    fulfillmentId: clean(fulfillment.fulfillmentId),
    orderLineNr: clean(line?.orderLineNr || fulfillment.orderLineNr),
    articleNumber: clean(fulfillment.articleNumber || fulfillment.artikelnummer || line?.articleNumber || line?.artikelnummer || fulfillment.sku || line?.sku),
    articleId: clean(fulfillment.articleId || fulfillment.artikelId || line?.articleId || line?.artikelId),
    sku: clean(fulfillment.sku || line?.sku || line?.barcode),
    barcode: clean(fulfillment.barcode || line?.barcode || fulfillment.sku || line?.sku),
    title: clean(fulfillment.productName || line?.title || line?.productName || line?.sku || fulfillment.sku),
    color: clean(fulfillment.color || fulfillment.kleur || line?.color || line?.kleur),
    size: clean(fulfillment.size || fulfillment.maat || line?.size || line?.maat),
    quantity,
    amount,
    srsStatus: status || fulfillment.status || 'unavailable',
    branchId,
    currentBranch: branchId || '',
    originBranch: branchId || '',
    lastResponsibleStore: store,
    srsUnavailableStore: directStore
  };

  return {
    idempotencyKey: [
      'srs-global-problem-order-line',
      orderNr,
      item.fulfillmentId,
      item.orderLineNr,
      item.articleNumber,
      item.barcode,
      normalizeStatus(item.srsStatus)
    ].join('::'),
    createdAt: srsDate,
    updatedAt: nowIso(),
    month: monthKey(srsDate),
    store,
    employeeName: 'SRS globale probleemregel synchronisatie',
    orderNr,
    type: 'partial',
    reason: problemLabel,
    customerEmail: detail?.customerEmail || clean(fulfillment.customerEmail),
    customerName: detail?.customerName || clean(fulfillment.customerName),
    amount,
    currency: 'EUR',
    items: [item],
    status: 'open',
    srsStatus: normalizedStatus.includes('cancel') || normalizedStatus.includes('geannuleerd') ? 'cancelled_in_srs' : 'unavailable_in_srs',
    srsCancelStatus: normalizedStatus.includes('cancel') || normalizedStatus.includes('geannuleerd') ? 'cancelled_in_srs' : 'pending',
    refundStatus: 'pending',
    mailStatus: 'pending',
    stockReturnStatus: 'skipped_no_stock_return',
    source: 'srs_global_fulfillments_problem_lines',
    srsSourceStatus: item.srsStatus,
    srsResult: {
      source: 'srs_global_fulfillments_problem_lines',
      detectedStatus: item.srsStatus,
      fulfillmentId: item.fulfillmentId,
      orderLineNr: item.orderLineNr,
      branchId,
      store,
      directStore,
      syncedAt: nowIso(),
      stockReturnStatus: 'skipped_no_stock_return'
    }
  };
}

async function getFulfillmentsForOrder(orderNr) {
  const result = await getFulfillments({ orderNr: cleanOrderNr(orderNr) });
  return result.fulfillments || [];
}

async function getProblemFulfillments({ orderNr = '', statuses, startedAt, maxRuntimeMs }) {
  if (orderNr) {
    const rows = await getFulfillmentsForOrder(orderNr);
    return {
      fulfillments: rows.filter((row) => isProblemStatus(row.status)),
      orderFulfillments: rows,
      errors: []
    };
  }

  const found = [];
  const errors = [];
  for (const status of statuses) {
    if (Date.now() - startedAt > maxRuntimeMs) break;
    try {
      const result = await getFulfillments({ status });
      const rows = (result.fulfillments || []).filter((row) => isProblemStatus(row.status || status));
      rows.forEach((row) => found.push({ ...row, requestedStatus: status }));
    } catch (error) {
      errors.push({ status, message: error.message || String(error) });
    }
  }

  const deduped = Array.from(new Map(found.map((item) => [
    item.fulfillmentId || `${cleanOrderNr(item.orderNr)}-${item.orderLineNr || ''}-${item.sku || item.barcode || ''}-${item.status || item.requestedStatus}`,
    item
  ])).values());

  return { fulfillments: deduped, orderFulfillments: deduped, errors };
}

export async function syncGlobalUnavailableOrderLines({
  orderNr = '',
  statuses = '',
  dateFrom = '',
  dateTo = '',
  month = '',
  dryRun = false,
  maxRuntimeMs = DEFAULT_MAX_RUNTIME_MS,
  maxRecords = DEFAULT_MAX_RECORDS
} = {}) {
  const startedAt = Date.now();
  const selectedStatuses = statusList(statuses);
  const detailsCache = new Map();
  const records = [];
  const errors = [];
  let created = 0;
  let duplicates = 0;
  let skippedByDate = 0;
  let skippedByLimit = 0;
  let scanned = 0;

  const result = await getProblemFulfillments({
    orderNr,
    statuses: selectedStatuses,
    startedAt,
    maxRuntimeMs
  });

  errors.push(...(result.errors || []));

  for (const fulfillment of result.fulfillments || []) {
    if (Date.now() - startedAt > maxRuntimeMs) break;
    if (scanned >= Number(maxRecords || DEFAULT_MAX_RECORDS)) {
      skippedByLimit += 1;
      continue;
    }

    const srsDate = fulfillmentDate(fulfillment);
    if (!dateInRange(srsDate, { dateFrom, dateTo, month })) {
      skippedByDate += 1;
      continue;
    }

    scanned += 1;
    const cleanNr = cleanOrderNr(fulfillment.orderNr);
    const detail = await getOrderDetails(cleanNr, detailsCache);
    const line = detailLineForFulfillment(detail, fulfillment);
    const orderFulfillments = orderNr ? (result.orderFulfillments || []) : [];
    const record = makeRecord({
      fulfillment,
      detail,
      line,
      status: fulfillment.status || fulfillment.requestedStatus || 'unavailable',
      orderFulfillments
    });

    records.push(record);

    if (!dryRun) {
      const addResult = await addOrderCancellation(record);
      if (addResult.duplicate) duplicates += 1;
      else created += 1;
    }
  }

  return {
    success: true,
    dryRun,
    partial: Date.now() - startedAt > maxRuntimeMs || skippedByLimit > 0,
    source: orderNr ? 'srs_order_fulfillments_problem_lines' : 'srs_global_fulfillments_problem_lines',
    orderNr: cleanOrderNr(orderNr),
    statuses: selectedStatuses,
    found: (result.fulfillments || []).length,
    scanned,
    created: dryRun ? 0 : created,
    duplicates: dryRun ? 0 : duplicates,
    skippedByDate,
    skippedByLimit,
    runtimeMs: Date.now() - startedAt,
    preview: dryRun ? records.slice(0, 100) : [],
    errors,
    message: dryRun
      ? `Dry-run klaar. ${records.length} geannuleerde/niet-leverbare SRS orderregel(s) gevonden.`
      : `SRS probleemregels sync klaar. ${created} nieuw, ${duplicates} al bekend, ${skippedByDate} buiten datumfilter overgeslagen.`
  };
}
