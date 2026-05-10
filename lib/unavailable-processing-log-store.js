import { list, put } from '@vercel/blob';

const STORE_KEY = 'unavailable-processing-logs/unavailable-processing-logs.json';
const MAX_LOGS = 5000;

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function clean(value) {
  return String(value || '').trim();
}

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `unavailable-log-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function euro(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function cleanOrderNr(input = {}) {
  return clean(
    input.orderNr ||
    input.orderName ||
    input.shopifyOrderNr ||
    input.weborderNr ||
    input.webOrderNr ||
    input.srsOrderNr ||
    input.customerOrderNr ||
    input.originalCancellation?.orderNr ||
    input.originalCancellation?.shopifyOrderNr ||
    input.originalCancellation?.weborderNr ||
    input.originalCancellation?.webOrderNr ||
    input.originalCancellation?.srsOrderNr ||
    ''
  ).replace(/^#/, '');
}

export function unavailableLineKey(input = {}) {
  const orderNr = cleanOrderNr(input);
  const fulfillmentId = clean(input.fulfillmentId || input.srsFulfillmentId || input.originalCancellation?.fulfillmentId);
  const orderLineNr = clean(input.orderLineNr || input.srsOrderLineNr || input.originalCancellation?.orderLineNr);
  const sku = clean(input.sku || input.barcode || input.articleNumber || input.articleId);
  const lineParts = [orderNr, fulfillmentId, orderLineNr, sku].map((part) => part.toLowerCase());

  if (orderNr && (fulfillmentId || orderLineNr || sku)) return lineParts.join('::');

  const fallback = clean(
    input.id ||
    input.cancellationId ||
    input.idempotencyKey ||
    input.originalCancellation?.id ||
    input.originalCancellation?.idempotencyKey ||
    ''
  ).toLowerCase();

  if (fallback) return [...lineParts, fallback].join('::');
  return lineParts.join('::');
}

function normalizeLog(input = {}) {
  const createdAt = input.createdAt || nowIso();
  const lineKey = clean(input.lineKey) || unavailableLineKey(input);

  return {
    id: input.id || createId(),
    createdAt,
    type: clean(input.type || input.event || 'unknown'),
    success: input.success !== false,
    orderNr: cleanOrderNr(input),
    lineKey,
    cancellationId: clean(input.cancellationId),
    fulfillmentId: clean(input.fulfillmentId),
    orderLineNr: clean(input.orderLineNr),
    sku: clean(input.sku || input.barcode || input.articleNumber),
    barcode: clean(input.barcode || input.sku || input.articleNumber),
    title: clean(input.title || input.productName),
    store: clean(input.store || input.lastResponsibleStore || 'Onbekend'),
    amount: euro(input.amount || input.refundAmount || input.matchedAmount || 0),
    currency: clean(input.currency || 'EUR'),
    refundStatus: clean(input.refundStatus),
    srsCancelStatus: clean(input.srsCancelStatus),
    processedBy: clean(input.processedBy || input.employeeName),
    message: clean(input.message || input.error || ''),
    result: input.result || null
  };
}

async function readBlobJson() {
  const result = await list({ prefix: STORE_KEY, limit: 1 });
  const blob = (result.blobs || []).find((item) => item.pathname === STORE_KEY) || result.blobs?.[0];
  if (!blob?.url) return { logs: [] };

  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) return { logs: [] };
  const text = await response.text();
  return safeJson(text, { logs: [] });
}

async function writeBlobJson(data) {
  await put(STORE_KEY, JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true
  });
}

export async function getUnavailableProcessingLogs() {
  const data = await readBlobJson();
  return Array.isArray(data.logs) ? data.logs.map(normalizeLog) : [];
}

export async function saveUnavailableProcessingLogs(logs = []) {
  const normalized = logs.map(normalizeLog).slice(0, MAX_LOGS);
  await writeBlobJson({ updatedAt: nowIso(), logs: normalized });
  return normalized;
}

export async function appendUnavailableProcessingLog(input = {}) {
  const current = await getUnavailableProcessingLogs();
  const next = normalizeLog(input);
  current.unshift(next);
  await saveUnavailableProcessingLogs(current);
  return next;
}

export async function listUnavailableProcessingLogs({ dateFrom = '', dateTo = '', store = '', orderNr = '', lineKey = '', limit = 1000 } = {}) {
  let logs = await getUnavailableProcessingLogs();

  const from = dateFrom ? new Date(dateFrom) : null;
  const to = dateTo ? new Date(dateTo) : null;
  const toExclusive = to && !Number.isNaN(to.getTime()) ? new Date(to.getFullYear(), to.getMonth(), to.getDate() + 1) : null;

  if (from && !Number.isNaN(from.getTime())) {
    logs = logs.filter((log) => {
      const d = new Date(log.createdAt || '');
      return !Number.isNaN(d.getTime()) && d >= from;
    });
  }

  if (toExclusive) {
    logs = logs.filter((log) => {
      const d = new Date(log.createdAt || '');
      return !Number.isNaN(d.getTime()) && d < toExclusive;
    });
  }

  const storeFilter = clean(store).toLowerCase();
  if (storeFilter && !['all', 'alle', '*'].includes(storeFilter)) logs = logs.filter((log) => clean(log.store).toLowerCase() === storeFilter);

  const orderFilter = clean(orderNr).replace(/^#/, '');
  if (orderFilter) logs = logs.filter((log) => log.orderNr === orderFilter);

  const lineKeyFilter = clean(lineKey).toLowerCase();
  if (lineKeyFilter) logs = logs.filter((log) => log.lineKey === lineKeyFilter);

  logs.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return logs.slice(0, Math.max(1, Math.min(5000, Number(limit || 1000))));
}

export function summarizeUnavailableProcessingLogs(logs = []) {
  const summary = logs.reduce((acc, log) => {
    const amount = Number(log.amount || 0);
    acc.totalLogs += 1;
    if (log.type === 'shopify_refund_created') {
      acc.shopifyRefundedRows += 1;
      acc.shopifyRefundedAmount += amount;
    }
    if (log.type === 'shopify_already_refunded') {
      acc.shopifyAlreadyRefundedRows += 1;
      acc.shopifyAlreadyRefundedAmount += amount;
    }
    if (log.type === 'srs_cancel_success') acc.srsCancelledRows += 1;
    if (log.type === 'srs_cancel_failed' || log.type === 'process_failed') acc.failedRows += 1;
    return acc;
  }, {
    totalLogs: 0,
    shopifyRefundedRows: 0,
    shopifyRefundedAmount: 0,
    shopifyAlreadyRefundedRows: 0,
    shopifyAlreadyRefundedAmount: 0,
    srsCancelledRows: 0,
    failedRows: 0
  });

  return {
    ...summary,
    shopifyRefundedAmount: euro(summary.shopifyRefundedAmount),
    shopifyAlreadyRefundedAmount: euro(summary.shopifyAlreadyRefundedAmount)
  };
}
