import { put, list } from '@vercel/blob';

const WEBORDER_LOG_PATH = 'weborders/interstore-weborders.json';
const OPEN_STATUSES = new Set([
  'accepted',
  'pending',
  'open',
  'srs_created',
  'pending_srs',
  'label_created',
  'in_behandeling',
  'te_verzenden',
  'failed_label',
  'aangemaakt',
  'aangevraagd',
  'onderweg',
  'in behandeling'
]);

function clean(value) {
  return String(value ?? '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return '';
}

function stripLocationPrefix(value) {
  const text = clean(value);
  if (!text) return '';

  // Examples from SRS: "20 - GENTS Rotterdam", "99 - Magazijn", "14 - GENTS Maastricht".
  return text.replace(/^\d+\s*-\s*/i, '').trim();
}

function extractBranchId(value) {
  const text = clean(value);
  const match = text.match(/^(\d+)\s*-/);
  return match ? match[1] : '';
}

function locationEqualsStore(locationValue, storeName) {
  const location = stripLocationPrefix(locationValue).toLowerCase();
  const store = clean(storeName).toLowerCase();
  if (!location || !store) return false;
  return location === store;
}

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

export async function createWeborderRequest(input = {}) {
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

export async function updateWeborderRequest(id, updates = {}) {
  const requests = await getWeborderRequests();

  const index = requests.findIndex((item) =>
    String(item.id) === String(id) ||
    String(item.orderId) === String(id) ||
    String(item.orderNr) === String(id) ||
    String(item.fulfillmentId) === String(id)
  );

  if (index === -1) return null;

  requests[index] = normalizeWeborder({
    ...requests[index],
    ...updates,
    updatedAt: new Date().toISOString()
  });

  await saveWeborderRequests(requests);

  return requests[index];
}

export function getAgeInHours(dateValue) {
  if (!dateValue) return 0;

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 0;

  return Math.max(0, Math.round((Date.now() - date.getTime()) / 36e5));
}

export function isOpenWeborderStatus(status) {
  const value = lower(status);
  if (!value) return true;

  if (OPEN_STATUSES.has(value)) return true;

  return (
    value.includes('open') ||
    value.includes('aangemaakt') ||
    value.includes('aangevraagd') ||
    value.includes('in behandeling') ||
    value.includes('te verzenden')
  );
}

export function isClosedWeborderStatus(status) {
  const value = lower(status);
  if (!value) return false;

  return (
    value.includes('geleverd') ||
    value.includes('afgerond') ||
    value.includes('geannuleerd') ||
    value.includes('cancelled') ||
    value.includes('canceled') ||
    value.includes('closed') ||
    value.includes('done')
  );
}

export function isDeliveredLineLocation(value) {
  const location = lower(stripLocationPrefix(value));

  return (
    location === 'klant' ||
    location.includes('klant') ||
    location.includes('uitlevertafel') ||
    location.includes('uitgeleverd') ||
    location.includes('geleverd')
  );
}

export function isWarehouseLineLocation(value) {
  const raw = lower(value);
  const location = lower(stripLocationPrefix(value));

  return (
    raw.startsWith('99 -') ||
    location === 'magazijn' ||
    location.includes('magazijn') ||
    location.includes('warehouse') ||
    location.includes('webshop')
  );
}

export function isOverdueWeborder(item = {}, deadlineHours = 48) {
  return isOpenWeborderStatus(item.status) &&
    !isClosedWeborderStatus(item.status) &&
    getAgeInHours(item.createdAt || item.orderDate || item.created || item.dateTime) >= Number(deadlineHours || 48);
}

export function getOrderKey(item = {}) {
  return clean(firstFilled(
    item.orderNr,
    item.orderNumber,
    item.orderName,
    item.orderId,
    item.weborderNumber,
    item.deliveryOrder,
    item.leveropdracht,
    item.fulfillmentId,
    item.id
  ));
}

export function getOrderLineKey(item = {}) {
  return clean(firstFilled(
    item.orderLineId,
    item.lineId,
    item.fulfillmentLineId,
    item.fulfillmentId && firstFilled(item.sku, item.barcode) ? `${item.fulfillmentId}-${firstFilled(item.sku, item.barcode)}` : '',
    `${getOrderKey(item)}-${firstFilled(item.lineNr, item.lineNumber, item.articleId, item.articleNumber, item.artikelnummer, item.sku, item.barcode)}-${firstFilled(item.currentBranchId, item.huidigBranchId, item.fulfilmentBranchId, item.fulfillmentBranchId)}`
  ));
}

export function normalizeWeborder(item = {}) {
  const originLocation = firstFilled(
    item.originStore,
    item.herkomstStore,
    item.herkomstFiliaalNaam,
    item.herkomstFiliaal,
    item.sellingStore,
    item.fromStore,
    item.sourceStore
  );

  const currentLocation = firstFilled(
    item.currentStore,
    item.huidigFiliaalNaam,
    item.huidigFiliaal,
    item.currentBranchName,
    item.currentBranch,
    item.fulfilmentStore,
    item.fulfillmentStore,
    item.store,
    item.branchName
  );

  const originStore = stripLocationPrefix(originLocation);
  const currentStore = stripLocationPrefix(currentLocation);

  const originBranchId = clean(firstFilled(
    item.originBranchId,
    item.herkomstBranchId,
    extractBranchId(originLocation),
    item.sellingBranchId
  ));

  const currentBranchId = clean(firstFilled(
    item.currentBranchId,
    item.huidigBranchId,
    item.huidigFiliaalId,
    extractBranchId(currentLocation),
    item.fulfilmentBranchId,
    item.fulfillmentBranchId,
    item.branchId
  ));

  const status = clean(firstFilled(
    item.status,
    item.srsStatus,
    item.lineStatus,
    item.orderLineStatus,
    item.fulfillmentStatus,
    item.statusLabel
  ));

  const createdAt = clean(firstFilled(
    item.createdAt,
    item.orderDate,
    item.created,
    item.dateTime,
    item.datum
  ));

  const normalized = {
    ...item,

    id: clean(firstFilled(item.id, item.fulfillmentId, getOrderLineKey(item))),
    orderLineId: clean(firstFilled(item.orderLineId, item.lineId, item.fulfillmentLineId, getOrderLineKey(item))),
    orderNr: clean(firstFilled(item.orderNr, item.orderNumber, item.orderName, item.orderId, item.leveropdracht, item.deliveryOrder)),
    orderId: clean(firstFilled(item.orderId, item.orderNr, item.orderNumber, item.orderName, item.leveropdracht, item.deliveryOrder)),

    status,
    createdAt,

    sku: clean(firstFilled(item.sku, item.barcode, item.productSku, item.articleNumber, item.artikelnummer)),
    barcode: clean(firstFilled(item.barcode, item.sku)),
    productName: clean(firstFilled(item.productName, item.title, item.name, item.product, item.description, item.omschrijving)),
    quantity: Number(firstFilled(item.quantity, item.pieces, item.aantal, 1) || 1),

    sellingStore: originStore,
    originStore,
    herkomstStore: originStore,
    herkomstFiliaalNaam: originStore,
    sellingBranchId: originBranchId,
    originBranchId,
    herkomstBranchId: originBranchId,

    fulfilmentStore: currentStore,
    fulfillmentStore: currentStore,
    currentStore,
    huidigFiliaalNaam: currentStore,
    currentLocationRaw: clean(currentLocation),
    currentBranchId,
    fulfilmentBranchId: currentBranchId,
    fulfillmentBranchId: currentBranchId,

    deliveredByStore: clean(firstFilled(item.deliveredByStore, item.uitgeleverdDoor, item.uitgeleverdDoorFiliaal)),

    ageHours: getAgeInHours(createdAt)
  };

  normalized.closed = isClosedWeborderStatus(normalized.status) || isDeliveredLineLocation(normalized.currentStore);
  normalized.delivered = isDeliveredLineLocation(normalized.currentStore) || lower(normalized.status).includes('geleverd');
  normalized.warehouse = isWarehouseLineLocation(normalized.currentLocationRaw || normalized.currentStore);
  normalized.overdue = isOverdueWeborder(normalized);

  return normalized;
}

export function isOrderLineOpenForStore(line = {}, storeName = '') {
  const item = normalizeWeborder(line);

  if (!storeName) return false;
  if (!item.currentStore) return false;
  if (item.closed || item.delivered) return false;
  if (item.warehouse) return false;
  if (!isOpenWeborderStatus(item.status)) return false;

  return locationEqualsStore(item.currentStore, storeName) || locationEqualsStore(item.currentLocationRaw, storeName);
}

export function groupOpenLinesByOrder(lines = [], storeName = '') {
  const openLines = lines
    .map(normalizeWeborder)
    .filter((line) => isOrderLineOpenForStore(line, storeName));

  const map = new Map();

  openLines.forEach((line) => {
    const orderKey = getOrderKey(line) || line.id || line.orderLineId;

    if (!map.has(orderKey)) {
      map.set(orderKey, {
        orderNr: orderKey,
        orderId: line.orderId || orderKey,
        customerName: line.customerName || line.customer || line.deliveryName || line.billingName || '',
        customerEmail: line.customerEmail || line.email || line.deliveryEmail || '',
        customerCity: line.deliveryCity || line.city || line.customerCity || '',
        createdAt: line.createdAt || '',
        ageHours: line.ageHours || 0,
        overdue: Boolean(line.overdue),
        lineCount: 0,
        quantity: 0,
        lines: []
      });
    }

    const row = map.get(orderKey);
    row.lines.push(line);
    row.lineCount += 1;
    row.quantity += Number(line.quantity || 1);
    row.ageHours = Math.max(Number(row.ageHours || 0), Number(line.ageHours || 0));
    row.overdue = row.overdue || Boolean(line.overdue);
  });

  return Array.from(map.values());
}

export function summarizeOpenWeborders(requests = [], storeName = '') {
  const normalized = requests.map(normalizeWeborder);
  const currentOpen = normalized.filter((item) => isOrderLineOpenForStore(item, storeName));
  const orderGroups = groupOpenLinesByOrder(currentOpen, storeName);
  const overdueLines = currentOpen.filter((item) => item.overdue);
  const overdueOrders = orderGroups.filter((order) => order.overdue);

  return {
    store: storeName,

    // Backwards-compatible names used by the existing Shopify JS.
    sellingOpenCount: 0,
    fulfilmentOpenCount: orderGroups.length,
    fulfillmentOpenCount: orderGroups.length,
    totalOpenCount: orderGroups.length,
    overdueCount: overdueOrders.length,

    // Explicit line-level numbers.
    currentOpenCount: orderGroups.length,
    currentOpenLineCount: currentOpen.length,
    openOrderCount: orderGroups.length,
    openLineCount: currentOpen.length,
    overdueLineCount: overdueLines.length,

    sellingOpen: [],
    originOpen: [],
    fulfilmentOpen: currentOpen,
    fulfillmentOpen: currentOpen,
    currentOpen,
    currentOpenOrders: orderGroups,
    overdue: overdueLines,
    overdueOrders
  };
}

export function summarizeOverdueByStore(requests = []) {
  const normalized = requests.map(normalizeWeborder);
  const map = new Map();

  normalized.forEach((item) => {
    if (!item.currentStore) return;
    if (item.closed || item.delivered || item.warehouse) return;
    if (!isOpenWeborderStatus(item.status)) return;

    const store = item.currentStore;

    if (!map.has(store)) {
      map.set(store, {
        store,
        openCount: 0,
        openLineCount: 0,
        overdueCount: 0,
        overdueLineCount: 0,
        overdueRate: 0,
        oldestAgeHours: 0,
        items: [],
        orderKeys: new Set(),
        overdueOrderKeys: new Set()
      });
    }

    const row = map.get(store);
    const orderKey = getOrderKey(item) || item.id || item.orderLineId;

    row.openLineCount += 1;
    row.orderKeys.add(orderKey);
    row.oldestAgeHours = Math.max(row.oldestAgeHours, Number(item.ageHours || 0));

    if (item.overdue) {
      row.overdueLineCount += 1;
      row.overdueOrderKeys.add(orderKey);
      row.items.push(item);
    }
  });

  return Array.from(map.values())
    .map((row) => {
      const openCount = row.orderKeys.size;
      const overdueCount = row.overdueOrderKeys.size;

      return {
        store: row.store,
        openCount,
        openLineCount: row.openLineCount,
        overdueCount,
        overdueLineCount: row.overdueLineCount,
        overdueRate: openCount ? Math.round((overdueCount / openCount) * 100) : 0,
        oldestAgeHours: row.oldestAgeHours,
        items: row.items
      };
    })
    .sort((a, b) =>
      b.overdueCount - a.overdueCount ||
      b.oldestAgeHours - a.oldestAgeHours ||
      a.store.localeCompare(b.store)
    );
}
