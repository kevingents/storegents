import { list, put } from '@vercel/blob';

const STORE_KEY = 'order-cancellations/order-cancellations.json';

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

function createId() {
  return crypto.randomUUID ? crypto.randomUUID() : `cancel-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function monthKeyFromDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return new Date().toISOString().slice(0, 7);
  return date.toISOString().slice(0, 7);
}

function normalizeReason(value) {
  return String(value || '').trim() || 'Niet leverbaar';
}

function normalizeCancellation(input = {}) {
  const createdAt = input.createdAt || nowIso();
  const type = input.type === 'full' ? 'full' : 'partial';
  const orderNr = String(input.orderNr || input.orderName || '').trim().replace(/^#/, '');
  const store = String(input.store || '').trim();
  const items = Array.isArray(input.items) ? input.items : [];

  return {
    id: input.id || createId(),
    idempotencyKey: input.idempotencyKey || buildIdempotencyKey({ store, orderNr, type, items }),
    createdAt,
    updatedAt: input.updatedAt || createdAt,
    month: input.month || monthKeyFromDate(createdAt),
    store,
    employeeName: String(input.employeeName || '').trim(),
    orderNr,
    type,
    reason: normalizeReason(input.reason),
    customerEmail: String(input.customerEmail || '').trim(),
    customerName: String(input.customerName || '').trim(),
    amount: Number(input.amount || 0),
    currency: input.currency || 'EUR',
    items: items.map((item) => ({
      fulfillmentId: String(item.fulfillmentId || '').trim(),
      orderLineNr: String(item.orderLineNr || '').trim(),
      sku: String(item.sku || '').trim(),
      title: String(item.title || item.productName || '').trim(),
      quantity: Number(item.quantity || item.pieces || 1),
      amount: Number(item.amount || item.price || 0),
      srsStatus: String(item.srsStatus || item.status || '').trim(),
      branchId: String(item.branchId || item.fulfilmentBranchId || item.fulfillmentBranchId || '').trim()
    })),
    status: input.status || 'requested',
    srsStatus: input.srsStatus || 'pending',
    refundStatus: input.refundStatus || 'pending',
    mailStatus: input.mailStatus || 'pending',
    error: input.error || '',
    source: input.source || '',
    srsSourceStatus: String(input.srsSourceStatus || input.srsStatus || '').trim(),
    srsResult: input.srsResult || null,
    refundResult: input.refundResult || null,
    mailResult: input.mailResult || null,
    processAttempts: Number(input.processAttempts || 0),
    processedAt: input.processedAt || '',
    processedBy: input.processedBy || ''
  };
}

export function buildIdempotencyKey({ store, orderNr, type, items = [] }) {
  const itemKey = (items || [])
    .map((item) => [item.fulfillmentId, item.orderLineNr, item.sku, item.srsStatus || item.status].filter(Boolean).join(':'))
    .filter(Boolean)
    .sort()
    .join('|');
  return [String(store || '').toLowerCase().trim(), String(orderNr || '').replace(/^#/, '').trim(), type || 'partial', itemKey || 'all'].join('::');
}

async function readBlobJson() {
  const result = await list({ prefix: STORE_KEY, limit: 1 });
  const blob = (result.blobs || []).find((item) => item.pathname === STORE_KEY) || result.blobs?.[0];
  if (!blob?.url) return { cancellations: [] };

  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) return { cancellations: [] };
  const text = await response.text();
  return safeJson(text, { cancellations: [] });
}

async function writeBlobJson(data) {
  await put(STORE_KEY, JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true
  });
}

export async function getOrderCancellations() {
  const data = await readBlobJson();
  return Array.isArray(data.cancellations) ? data.cancellations.map(normalizeCancellation) : [];
}

export async function saveOrderCancellations(cancellations) {
  const normalized = (cancellations || []).map(normalizeCancellation);
  await writeBlobJson({ updatedAt: nowIso(), cancellations: normalized });
  return normalized;
}

export async function addOrderCancellation(input) {
  const current = await getOrderCancellations();
  const next = normalizeCancellation(input);
  const existing = current.find((item) => item.idempotencyKey === next.idempotencyKey && item.status !== 'failed');
  if (existing) return { cancellation: existing, duplicate: true };
  current.unshift(next);
  await saveOrderCancellations(current);
  return { cancellation: next, duplicate: false };
}

export async function updateOrderCancellation(id, patch = {}) {
  const current = await getOrderCancellations();
  const index = current.findIndex((item) => item.id === id);
  if (index < 0) throw new Error('Annulering niet gevonden.');
  current[index] = normalizeCancellation({ ...current[index], ...patch, updatedAt: nowIso() });
  await saveOrderCancellations(current);
  return current[index];
}

export async function getOrderCancellationById(id) {
  const current = await getOrderCancellations();
  return current.find((item) => item.id === id) || null;
}

export function monthKeyFromCancellation(item = {}) {
  const rawDate = item.createdAt || item.created_at || item.date || item.updatedAt || '';
  const parsed = rawDate ? new Date(rawDate) : null;

  if (parsed && !Number.isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 7);
  }

  return String(item.month || '').slice(0, 7);
}

export function filterCancellationsByMonth(cancellations, month) {
  const key = month || monthKeyFromDate();

  return (cancellations || []).filter((item) => {
    return monthKeyFromCancellation(item) === key;
  });
}

export function cancellationLineRows(cancellations) {
  const rows = [];

  for (const item of cancellations || []) {
    const items = Array.isArray(item.items) && item.items.length ? item.items : [{}];

    items.forEach((line, index) => {
      const quantity = Number(line.quantity || line.pieces || 1);
      const amount = Number(line.amount || 0);
      const lineStatus = String(line.srsStatus || line.status || item.srsSourceStatus || item.srsStatus || '').trim();

      rows.push({
        cancellationId: item.id,
        idempotencyKey: [item.idempotencyKey || item.id || '', line.fulfillmentId || '', line.orderLineNr || '', line.sku || '', line.barcode || '', index].join('::'),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        month: item.month,
        store: item.store || 'Onbekend',
        employeeName: item.employeeName || '',
        orderNr: item.orderNr || '',
        fulfillmentId: String(line.fulfillmentId || '').trim(),
        orderLineNr: String(line.orderLineNr || '').trim(),
        articleNumber: String(line.articleNumber || line.artikelnummer || line.sku || '').trim(),
        articleId: String(line.articleId || line.artikelId || '').trim(),
        sku: String(line.sku || '').trim(),
        barcode: String(line.barcode || '').trim(),
        title: String(line.title || line.productName || '').trim(),
        color: String(line.color || line.kleur || '').trim(),
        size: String(line.size || line.maat || '').trim(),
        currentBranch: String(line.currentBranch || line.huidigFiliaal || line.branchId || '').trim(),
        branchId: String(line.branchId || '').trim(),
        quantity,
        amount,
        currency: item.currency || 'EUR',
        type: item.type === 'full' ? 'full' : 'line',
        reason: item.reason || '',
        customerEmail: item.customerEmail || '',
        customerName: item.customerName || '',
        status: item.status || 'completed',
        srsStatus: item.srsStatus || lineStatus || 'pending',
        srsLineStatus: lineStatus,
        refundStatus: item.refundStatus || 'pending',
        mailStatus: item.mailStatus || 'pending',
        error: item.error || '',
        source: item.source || '',
        originalCancellation: item
      });
    });
  }

  return rows;
}

export function summarizeCancellationsByStore(cancellations) {
  const map = new Map();
  const lineRows = cancellationLineRows(cancellations);

  for (const line of lineRows || []) {
    const store = line.store || 'Onbekend';
    if (!map.has(store)) {
      map.set(store, {
        store,
        totalCancellations: 0,
        fullCancellations: 0,
        partialCancellations: 0,
        itemCount: 0,
        uniqueOrderCount: 0,
        refundAmount: 0,
        failedCount: 0,
        srsFailedCount: 0,
        refundFailedCount: 0,
        mailFailedCount: 0,
        lastCancellationAt: '',
        orderNumbers: []
      });
    }

    const row = map.get(store);
    row.totalCancellations += 1;
    row.fullCancellations += line.type === 'full' ? 1 : 0;
    row.partialCancellations += line.type !== 'full' ? 1 : 0;
    row.itemCount += Number(line.quantity || 1);
    row.refundAmount += Number(line.amount || 0);
    row.failedCount += line.status === 'failed' ? 1 : 0;
    row.srsFailedCount += line.srsStatus === 'failed' ? 1 : 0;
    row.refundFailedCount += line.refundStatus === 'failed' ? 1 : 0;
    row.mailFailedCount += line.mailStatus === 'failed' ? 1 : 0;
    if (line.orderNr && !row.orderNumbers.includes(line.orderNr)) row.orderNumbers.push(line.orderNr);
    row.uniqueOrderCount = row.orderNumbers.length;
    if (!row.lastCancellationAt || String(line.createdAt) > row.lastCancellationAt) row.lastCancellationAt = line.createdAt;
  }

  return Array.from(map.values())
    .map((row) => ({ ...row, orderNumbers: undefined }))
    .sort((a, b) => b.totalCancellations - a.totalCancellations || b.refundAmount - a.refundAmount);
}

export function monthKeyFromInput(value) {
  return /^\d{4}-\d{2}$/.test(String(value || '')) ? String(value) : monthKeyFromDate();
}
