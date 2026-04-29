import { put, list } from '@vercel/blob';

const WEBORDER_LOG_PATH = 'weborders/interstore-weborders.json';

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
  const record = normalizeWeborder({
    id: String(Date.now()),
    orderId: input.orderId || input.orderNr || '',
    orderNr: input.orderNr || input.orderId || '',
    fulfillmentId: input.fulfillmentId || '',
    source: input.source || 'portal',
    srsCreated: Boolean(input.srsCreated),
    status: input.status || 'open',
    sellingStore: input.sellingStore || '',
    sellingBranchId: input.sellingBranchId || '',
    fulfilmentStore: input.fulfilmentStore || input.fulfillmentStore || '',
    fulfillmentStore: input.fulfillmentStore || input.fulfilmentStore || '',
    fulfilmentBranchId: input.fulfilmentBranchId || input.fulfillmentBranchId || '',
    fulfillmentBranchId: input.fulfillmentBranchId || input.fulfilmentBranchId || '',
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
    createdAt: input.createdAt || new Date().toISOString(),
    updatedAt: input.updatedAt || new Date().toISOString()
  });

  requests.unshift(record);
  await saveWeborderRequests(requests);
  return record;
}

export async function updateWeborderRequest(id, updates) {
  const requests = await getWeborderRequests();
  const index = requests.findIndex((item) => String(item.id) === String(id) || String(item.orderId) === String(id) || String(item.orderNr) === String(id) || String(item.fulfillmentId) === String(id));
  if (index === -1) return null;
  requests[index] = normalizeWeborder({ ...requests[index], ...updates, updatedAt: new Date().toISOString() });
  await saveWeborderRequests(requests);
  return requests[index];
}

export function isOpenWeborderStatus(status) {
  return ['accepted', 'pending', 'open', 'srs_created', 'pending_srs', 'label_created', 'in_behandeling', 'te_verzenden', 'failed_label'].includes(String(status || '').toLowerCase());
}

export function getAgeInHours(dateValue) {
  if (!dateValue) return 0;
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 36e5));
}

export function isOverdueWeborder(item, deadlineHours = 48) {
  return isOpenWeborderStatus(item.status) && getAgeInHours(item.createdAt) >= Number(deadlineHours || 48);
}

export function normalizeWeborder(item) {
  const fulfilmentStore = item.fulfilmentStore || item.fulfillmentStore || '';
  const fulfilmentBranchId = item.fulfilmentBranchId || item.fulfillmentBranchId || '';

  return {
    ...item,
    orderNr: item.orderNr || item.orderId || '',
    orderId: item.orderId || item.orderNr || '',
    fulfilmentStore,
    fulfillmentStore: fulfilmentStore,
    fulfilmentBranchId,
    fulfillmentBranchId: fulfilmentBranchId,
    ageHours: getAgeInHours(item.createdAt),
    overdue: isOverdueWeborder(item)
  };
}

export function summarizeOpenWeborders(requests, storeName) {
  const normalized = requests.map(normalizeWeborder);
  const open = normalized.filter((item) => isOpenWeborderStatus(item.status));

  const sellingOpen = open.filter((item) => item.sellingStore === storeName);
  const fulfilmentOpen = open.filter((item) => item.fulfilmentStore === storeName);
  const overdue = open.filter((item) => (item.sellingStore === storeName || item.fulfilmentStore === storeName) && item.overdue);

  return {
    store: storeName,
    sellingOpenCount: sellingOpen.length,
    fulfilmentOpenCount: fulfilmentOpen.length,
    overdueCount: overdue.length,
    totalOpenCount: sellingOpen.length + fulfilmentOpen.length,
    sellingOpen,
    fulfilmentOpen,
    overdue
  };
}

export function summarizeOverdueByStore(requests) {
  const normalized = requests.map(normalizeWeborder).filter((item) => isOpenWeborderStatus(item.status));
  const map = new Map();

  normalized.forEach((item) => {
    const store = item.fulfilmentStore || item.sellingStore || 'Onbekend';
    if (!map.has(store)) {
      map.set(store, { store, openCount: 0, overdueCount: 0, oldestAgeHours: 0, items: [] });
    }

    const row = map.get(store);
    row.openCount += 1;
    row.oldestAgeHours = Math.max(row.oldestAgeHours, item.ageHours || 0);
    if (item.overdue) {
      row.overdueCount += 1;
      row.items.push(item);
    }
  });

  return Array.from(map.values())
    .sort((a, b) => b.overdueCount - a.overdueCount || b.oldestAgeHours - a.oldestAgeHours || a.store.localeCompare(b.store));
}
