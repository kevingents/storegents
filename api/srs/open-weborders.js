function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function emptySummary(store) {
  return {
    store,
    sellingOpenCount: 0,
    fulfilmentOpenCount: 0,
    fulfillmentOpenCount: 0,
    currentOpenCount: 0,
    currentOpenLineCount: 0,
    openOrderCount: 0,
    openLineCount: 0,
    overdueCount: 0,
    overdueLineCount: 0,
    totalOpenCount: 0,
    sellingOpen: [],
    originOpen: [],
    fulfilmentOpen: [],
    fulfillmentOpen: [],
    currentOpen: [],
    currentOpenOrders: [],
    overdue: [],
    overdueOrders: []
  };
}

function normalizeStore(value) {
  return String(value || '').trim();
}

function clean(value) {
  return String(value ?? '').trim();
}

function mapInternalLocation(item = {}) {
  const id = clean(item.currentBranchId || item.huidigBranchId || item.huidigFiliaalId || item.fulfilmentBranchId || item.fulfillmentBranchId || item.branchId);
  const raw = clean(item.currentLocationRaw || item.currentStore || item.huidigFiliaalNaam || item.huidigFiliaal || item.fulfilmentStore || item.fulfillmentStore || item.store || item.branchName);
  const value = raw.toLowerCase();
  if (id === '97' || id === '99' || value.includes('uitlevertafel') || value.includes('uitlever tafel') || value.includes('magazijn') || value.includes('warehouse') || value.includes('webshop')) return 'GENTS Magazijn';
  if (id === '700' || value.includes('showroom')) return 'GENTS Showroom';
  return item.currentStore || item.fulfilmentStore || item.fulfillmentStore || raw;
}

function normalizePortalWeborder(item = {}) {
  const mappedStore = mapInternalLocation(item);
  const mapped = {
    ...item,
    currentStore: mappedStore,
    huidigFiliaalNaam: mappedStore,
    fulfilmentStore: mappedStore,
    fulfillmentStore: mappedStore
  };
  if (mappedStore === 'GENTS Magazijn') {
    mapped.warehouse = true;
    mapped.closed = false;
    mapped.delivered = false;
  }
  if (mappedStore === 'GENTS Showroom') {
    mapped.closed = false;
    mapped.delivered = false;
  }
  return mapped;
}

function storeMatches(item = {}, store = '') {
  const expected = normalizeStore(store).toLowerCase().replace(/^gents\s+/, '');
  const actual = normalizeStore(item.currentStore || item.fulfilmentStore || item.fulfillmentStore || '').toLowerCase().replace(/^gents\s+/, '');
  return expected && actual && expected === actual;
}

function isOpenItem(weborders, item = {}, store = '') {
  if (!weborders.isOpenWeborderStatus(item.status)) return false;
  if (item.closed || item.delivered) return false;
  if (store) return storeMatches(item, store);
  return true;
}

function orderKey(weborders, item = {}) {
  return weborders.getOrderKey?.(item) || item.orderNr || item.orderId || item.id || item.orderLineId || '';
}

function summarizeForStore(weborders, items = [], store = '') {
  const openLines = items.filter((item) => isOpenItem(weborders, item, store));
  const orders = new Map();
  openLines.forEach((item) => {
    const key = orderKey(weborders, item) || item.id;
    if (!orders.has(key)) orders.set(key, { orderNr: key, orderId: item.orderId || key, overdue: false, lines: [], lineCount: 0, ageHours: 0 });
    const row = orders.get(key);
    row.lines.push(item);
    row.lineCount += 1;
    row.overdue = row.overdue || Boolean(item.overdue);
    row.ageHours = Math.max(Number(row.ageHours || 0), Number(item.ageHours || 0));
  });
  const orderRows = Array.from(orders.values());
  const overdueLines = openLines.filter((item) => item.overdue);
  const overdueOrders = orderRows.filter((item) => item.overdue);
  return {
    ...emptySummary(store),
    fulfilmentOpenCount: orderRows.length,
    fulfillmentOpenCount: orderRows.length,
    currentOpenCount: orderRows.length,
    currentOpenLineCount: openLines.length,
    openOrderCount: orderRows.length,
    openLineCount: openLines.length,
    overdueCount: overdueOrders.length,
    overdueLineCount: overdueLines.length,
    totalOpenCount: orderRows.length,
    fulfilmentOpen: openLines,
    fulfillmentOpen: openLines,
    currentOpen: openLines,
    currentOpenOrders: orderRows,
    overdue: overdueLines,
    overdueOrders
  };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  const store = normalizeStore(req.query.store);
  const branchId = String(req.query.branchId || '').trim();

  try {
    const client = await import('../../lib/srs-open-weborders-client.js');
    const weborders = await import('../../lib/weborder-request-store.js');
    const branches = await import('../../lib/branch-metrics.js');

    const resolvedBranchId = branchId || String(branches.getBranchIdByStore?.(store) || '').trim();
    const result = await client.getSrsOpenWeborders({ store, branchId: resolvedBranchId });
    const items = (result.items || []).map((item) => normalizePortalWeborder(weborders.normalizeWeborder(item)));

    const summary = store
      ? summarizeForStore(weborders, items, store)
      : emptySummary(store);

    const requests = store
      ? items
          .filter((item) => isOpenItem(weborders, item, store))
          .slice(0, 500)
      : items
          .filter((item) => isOpenItem(weborders, item, ''))
          .slice(0, 1000);

    return res.status(200).json({
      success: true,
      source: result.source || 'srs_open_weborders',
      note: result.note || '',
      degraded: Boolean(result.degraded),
      store,
      branchId: resolvedBranchId,
      ownerLogic: 'order-line-current-branch',
      ownerLogicNote: 'Openstaande winkelactie wordt per orderregel bepaald op basis van Huidig filiaal. Herkomst filiaal is context. Filiaal 97/99 telt als Magazijn en 700 als Showroom.',
      deadlineHours: 48,
      summary,
      open: summary.totalOpenCount || summary.openOrderCount || 0,
      openLines: summary.openLineCount || summary.currentOpenLineCount || 0,
      overdue: summary.overdueCount || 0,
      overdueLines: summary.overdueLineCount || 0,
      requests
    });
  } catch (error) {
    console.error('SRS open weborders safe fallback:', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      source: 'safe_empty_fallback',
      note: error.message || 'Open weborders konden niet worden opgehaald. Lege fallback gebruikt zodat het winkelportaal blijft laden.',
      store,
      branchId,
      ownerLogic: 'order-line-current-branch',
      deadlineHours: 48,
      summary: emptySummary(store),
      open: 0,
      openLines: 0,
      overdue: 0,
      overdueLines: 0,
      requests: []
    });
  }
}
