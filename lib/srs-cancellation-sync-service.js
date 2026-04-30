import { getFulfillments, getWebordersWithDetails } from './srs-weborders-message-client.js';
import { listBranches, getBranchIdByStore, getStoreNameByBranchId } from './branch-metrics.js';
import { addOrderCancellation } from './order-cancellation-store.js';

const DEFAULT_STATUSES = 'niet leverbaar,geannuleerd,unavailable,cancelled,canceled';
const DEFAULT_MIN_DATE = '2026-01-01';

export function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'ja'].includes(String(value).toLowerCase());
}

export function cleanStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
}

export function statusListFromValue(value) {
  const raw = String(value || process.env.SRS_CANCELLATION_SYNC_STATUSES || DEFAULT_STATUSES).trim();
  return raw.split(/[;,]+/).map((item) => item.trim()).filter(Boolean);
}

export function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

export function monthFromValue(value) {
  return /^\d{4}-\d{2}$/.test(String(value || '')) ? String(value) : currentMonth();
}

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
}

function monthKeyFromDateValue(value, fallbackMonth) {
  const date = validDate(value);
  return date ? date.toISOString().slice(0, 7) : fallbackMonth;
}

function shouldSkipBecauseOfDate(value, selectedMonth) {
  const date = validDate(value);
  const minDate = validDate(process.env.SRS_CANCELLATION_SYNC_MIN_DATE || DEFAULT_MIN_DATE);
  const maxDate = validDate(process.env.SRS_CANCELLATION_SYNC_MAX_DATE || '');

  if (date && minDate && date < minDate) return true;
  if (date && maxDate && date >= maxDate) return true;
  if (date && selectedMonth && date.toISOString().slice(0, 7) !== selectedMonth) return true;

  return false;
}

function parseNumber(value, fallback = 0) {
  const n = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
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

export function branchFromInput({ store = '', branchId = '' } = {}) {
  const requestedStore = String(store || '').trim();
  const requestedBranchId = String(branchId || '').trim();

  if (requestedBranchId) {
    return {
      store: getStoreNameByBranchId(requestedBranchId),
      branchId: requestedBranchId
    };
  }

  if (requestedStore) {
    const mappedBranchId = getBranchIdByStore(requestedStore);
    if (mappedBranchId) return { store: requestedStore, branchId: String(mappedBranchId) };

    const found = listBranches().find((branch) => cleanStatus(branch.store) === cleanStatus(requestedStore));
    if (found?.branchId) return { store: found.store, branchId: String(found.branchId) };
  }

  return null;
}

async function getDetailsForOrder(orderNr, cache) {
  const clean = String(orderNr || '').replace(/^#/, '').trim();
  if (!clean) return null;
  if (cache.has(clean)) return cache.get(clean);

  try {
    const result = await getWebordersWithDetails(clean);
    const detail = result.detailsByOrder?.get(clean) || null;
    cache.set(clean, detail);
    return detail;
  } catch (error) {
    console.warn('SRS cancellation sync: GetWebordersWithDetails failed for', clean, error.message);
    cache.set(clean, null);
    return null;
  }
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

async function collectSrsCancellationFulfillments({ branch, statuses, startedAt, maxRuntimeMs }) {
  const errors = [];
  const found = [];

  for (const status of statuses) {
    if (Date.now() - startedAt > maxRuntimeMs) break;

    try {
      const result = await getFulfillments({ branchId: branch.branchId, status });
      const rows = (result.fulfillments || []).filter((item) => isCancellationStatus(item.status || status));
      rows.forEach((item) => found.push({ ...item, requestedStatus: status, branch }));
    } catch (error) {
      errors.push({ store: branch.store, branchId: branch.branchId, status, message: error.message });
    }
  }

  const deduped = Array.from(new Map(found.map((item) => [
    item.fulfillmentId || `${item.orderNr}-${item.orderLineNr || ''}-${item.sku}-${item.barcode}-${branch.branchId}-${item.status || item.requestedStatus}`,
    item
  ])).values());

  return { fulfillments: deduped, errors };
}

export async function syncSrsCancellationsForBranch({
  store,
  branchId,
  month,
  dryRun = false,
  statuses,
  maxRuntimeMs = Number(process.env.SRS_CANCELLATION_SYNC_MAX_RUNTIME_MS || 22000),
  maxRecords = Number(process.env.SRS_CANCELLATION_SYNC_MAX_RECORDS || 50),
  startedAt = Date.now()
} = {}) {
  const branch = branchFromInput({ store, branchId });
  if (!branch?.branchId) {
    throw new Error('Kies één winkel of geef branchId mee. Alle winkels tegelijk synchroniseren is uitgeschakeld.');
  }

  const selectedMonth = monthFromValue(month);
  const statusList = statusListFromValue(statuses);
  const detailsCache = new Map();
  const { fulfillments, errors } = await collectSrsCancellationFulfillments({
    branch,
    statuses: statusList,
    startedAt,
    maxRuntimeMs
  });

  let created = 0;
  let duplicates = 0;
  let skippedByDate = 0;
  let skippedByLimit = 0;
  let scanned = 0;
  const records = [];

  for (const fulfillment of fulfillments) {
    if (Date.now() - startedAt > maxRuntimeMs) break;

    if (scanned >= maxRecords) {
      skippedByLimit += 1;
      continue;
    }

    scanned += 1;

    const orderNr = String(fulfillment.orderNr || '').replace(/^#/, '').trim();
    const srsDate = fulfillmentDate(fulfillment);

    if (shouldSkipBecauseOfDate(srsDate, selectedMonth)) {
      skippedByDate += 1;
      continue;
    }

    const detail = await getDetailsForOrder(orderNr, detailsCache);
    const line = detailLineForFulfillment(detail, fulfillment);
    const quantity = parseNumber(line?.pieces || line?.quantity || fulfillment.quantity || fulfillment.pieces, 1);
    const unitAmount = parseNumber(line?.price || fulfillment.productPrice || fulfillment.price, 0);
    const amount = Math.max(0, quantity * unitAmount);
    const status = fulfillment.status || fulfillment.requestedStatus || 'unavailable';
    const reason = statusReason(status);

    const item = {
      fulfillmentId: fulfillment.fulfillmentId || '',
      orderLineNr: line?.orderLineNr || fulfillment.orderLineNr || '',
      articleNumber: fulfillment.articleNumber || fulfillment.artikelnummer || line?.articleNumber || line?.artikelnummer || fulfillment.sku || '',
      articleId: fulfillment.articleId || fulfillment.artikelId || line?.articleId || line?.artikelId || '',
      sku: fulfillment.sku || line?.sku || '',
      barcode: fulfillment.barcode || line?.barcode || '',
      title: fulfillment.productName || line?.title || line?.productName || line?.sku || fulfillment.sku || '',
      color: fulfillment.color || fulfillment.kleur || line?.color || line?.kleur || '',
      size: fulfillment.size || fulfillment.maat || line?.size || line?.maat || '',
      currentBranch: fulfillment.currentBranch || fulfillment.huidigFiliaal || fulfillment.currentBranchName || '',
      quantity,
      amount,
      srsStatus: status,
      branchId: branch.branchId
    };

    const payload = {
      idempotencyKey: [
        'srs-sync-order-line',
        String(branch.store || '').toLowerCase().trim(),
        orderNr,
        item.fulfillmentId,
        item.orderLineNr,
        item.articleNumber,
        item.barcode,
        cleanStatus(status)
      ].join('::'),
      createdAt: srsDate || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      month: monthKeyFromDateValue(srsDate, selectedMonth),
      store: branch.store,
      employeeName: 'SRS automatische synchronisatie',
      orderNr,
      type: 'partial',
      reason,
      customerEmail: detail?.customerEmail || '',
      customerName: detail?.customerName || fulfillment.customerName || '',
      amount,
      currency: 'EUR',
      items: [item],
      status: 'completed',
      srsStatus: cleanStatus(status).includes('cancel') || cleanStatus(status).includes('geannuleerd') ? 'cancelled_in_srs' : 'unavailable_in_srs',
      refundStatus: 'pending',
      mailStatus: 'pending',
      source: 'srs_get_fulfillments_order_line_sync',
      srsResult: {
        source: 'srs_get_fulfillments_order_line_sync',
        detectedStatus: status,
        fulfillmentId: item.fulfillmentId,
        orderLineNr: item.orderLineNr,
        branchId: branch.branchId,
        syncedAt: new Date().toISOString()
      }
    };

    records.push(payload);

    if (!dryRun) {
      const result = await addOrderCancellation(payload);
      if (result.duplicate) duplicates += 1;
      else created += 1;
    }
  }

  const partial = Date.now() - startedAt > maxRuntimeMs || skippedByLimit > 0;

  return {
    success: true,
    dryRun,
    partial,
    month: selectedMonth,
    store: branch.store,
    branchId: branch.branchId,
    source: 'srs_get_fulfillments_order_lines_per_store',
    statuses: statusList,
    branchesScanned: 1,
    scanned,
    found: fulfillments.length,
    created: dryRun ? 0 : created,
    duplicates: dryRun ? 0 : duplicates,
    skippedByDate,
    skippedByLimit,
    runtimeMs: Date.now() - startedAt,
    preview: dryRun ? records.slice(0, 50) : [],
    errors,
    message: dryRun
      ? `Dry-run klaar voor ${branch.store}. ${records.length} SRS orderregel(s) gevonden.`
      : `Synchronisatie klaar voor ${branch.store}. ${created} nieuw, ${duplicates} al bekend, ${skippedByDate} buiten maand/datumbereik overgeslagen.`
  };
}
