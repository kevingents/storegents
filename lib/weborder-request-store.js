import { put, list } from '@vercel/blob';

const WEBORDER_LOG_PATH = 'weborders/interstore-weborders.json';
const OPEN_WEBORDER_STATUSES = ['accepted', 'pending', 'unavailable', 'open', 'srs_created', 'label_created', 'in_behandeling', 'te_verzenden'];

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Weborderlog kon niet worden gelezen.');
  return response.text();
}

export async function getWeborderRequests() {
  try {
    const result = await list({ prefix: WEBORDER_LOG_PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === WEBORDER_LOG_PATH);
    if (!blob) return [];

    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '[]');
  } catch (error) {
    console.error('Read weborder requests error:', error);
    return [];
  }
}

export async function saveWeborderRequests(requests) {
  await put(WEBORDER_LOG_PATH, JSON.stringify(requests, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export async function createWeborderRequest(input) {
  const requests = await getWeborderRequests();

  const record = {
    id: String(Date.now()),
    orderId: input.orderId || '',
    srsCreated: Boolean(input.srsCreated),
    status: input.status || 'open',
    sellingStore: input.sellingStore || '',
    sellingBranchId: input.sellingBranchId || '',
    fulfilmentStore: input.fulfilmentStore || '',
    fulfilmentBranchId: input.fulfilmentBranchId || '',
    customerName: input.customerName || '',
    customerEmail: input.customerEmail || '',
    customerPhone: input.customerPhone || '',
    sku: input.sku || '',
    productName: input.productName || '',
    productPrice: Number(input.productPrice || 0),
    quantity: Number(input.quantity || 1),
    shippingCost: Number(input.shippingCost || 0),
    paymentType: input.paymentType || '',
    employeeName: input.employeeName || '',
    note: input.note || '',
    trackingNumber: input.trackingNumber || '',
    sendcloudLabelUrl: input.sendcloudLabelUrl || '',
    srsResponse: input.srsResponse || null,
    error: input.error || '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  requests.unshift(record);
  await saveWeborderRequests(requests);
  return record;
}

export async function updateWeborderRequest(id, updates) {
  const requests = await getWeborderRequests();
  const index = requests.findIndex((item) => String(item.id) === String(id) || String(item.orderId) === String(id));
  if (index === -1) return null;

  requests[index] = {
    ...requests[index],
    ...updates,
    updatedAt: new Date().toISOString()
  };

  await saveWeborderRequests(requests);
  return requests[index];
}

export function summarizeOpenWeborders(requests, storeName) {
  const sellingOpen = requests.filter((item) => {
    return item.sellingStore === storeName && isOpenWeborderStatus(item.status);
  });

  const fulfilmentOpen = requests.filter((item) => {
    return item.fulfilmentStore === storeName && isOpenWeborderStatus(item.status);
  });

  return {
    store: storeName,
    sellingOpenCount: sellingOpen.length,
    fulfilmentOpenCount: fulfilmentOpen.length,
    totalOpenCount: sellingOpen.length + fulfilmentOpen.length,
    sellingOpen,
    fulfilmentOpen
  };
}

export function isOpenWeborderStatus(status) {
  return OPEN_WEBORDER_STATUSES.includes(String(status || '').toLowerCase());
}

export function normalizeWeborder(input = {}) {
  return {
    id: String(input.id || input.fulfillmentId || `${input.orderNr || ''}-${input.sku || ''}`).trim(),
    orderNr: String(input.orderNr || input.orderId || '').trim(),
    orderId: String(input.orderId || input.orderNr || '').trim(),
    fulfillmentId: String(input.fulfillmentId || '').trim(),
    status: String(input.status || 'open').toLowerCase(),
    sku: String(input.sku || input.barcode || '').trim(),
    productName: String(input.productName || input.sku || '').trim(),
    customerName: String(input.customerName || '').trim(),
    fulfilmentBranchId: String(input.fulfilmentBranchId || input.fulfillmentBranchId || '').trim(),
    fulfillmentBranchId: String(input.fulfillmentBranchId || input.fulfilmentBranchId || '').trim(),
    fulfilmentStore: String(input.fulfilmentStore || input.fulfillmentStore || '').trim(),
    fulfillmentStore: String(input.fulfillmentStore || input.fulfilmentStore || '').trim(),
    sellingStore: String(input.sellingStore || '').trim(),
    quantity: Number(input.quantity || 1),
    productPrice: Number(input.productPrice || 0),
    createdAt: input.createdAt || '',
    updatedAt: input.updatedAt || ''
  };
}

export function summarizeOverdueByStore(items, deadlineHours = 48) {
  const now = Date.now();
  const deadlineMs = deadlineHours * 60 * 60 * 1000;
  const map = new Map();

  for (const rawItem of items || []) {
    const item = normalizeWeborder(rawItem);
    if (!isOpenWeborderStatus(item.status)) continue;

    const store = item.fulfilmentStore || item.fulfillmentStore || 'Onbekend';
    const createdAtMs = item.createdAt ? Date.parse(item.createdAt) : NaN;
    const isOverdue = Number.isFinite(createdAtMs) ? (now - createdAtMs > deadlineMs) : false;

    const row = map.get(store) || {
      store,
      openCount: 0,
      overdueCount: 0,
      overdueRate: 0,
      items: []
    };

    row.openCount += 1;
    if (isOverdue) {
      row.overdueCount += 1;
      row.items.push({
        id: item.id,
        orderNr: item.orderNr,
        sku: item.sku,
        customerName: item.customerName,
        createdAt: item.createdAt,
        ageHours: Number.isFinite(createdAtMs) ? Math.floor((now - createdAtMs) / (1000 * 60 * 60)) : null
      });
    }

    row.overdueRate = row.openCount ? Math.round((row.overdueCount / row.openCount) * 100) : 0;
    map.set(store, row);
  }

  return Array.from(map.values()).sort((a, b) => {
    if (b.overdueCount !== a.overdueCount) return b.overdueCount - a.overdueCount;
    return b.openCount - a.openCount;
  });
}
