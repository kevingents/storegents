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
  const openStatuses = ['open', 'srs_created', 'label_created', 'in_behandeling', 'te_verzenden'];

  const sellingOpen = requests.filter((item) => {
    return item.sellingStore === storeName && openStatuses.includes(item.status);
  });

  const fulfilmentOpen = requests.filter((item) => {
    return item.fulfilmentStore === storeName && openStatuses.includes(item.status);
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
