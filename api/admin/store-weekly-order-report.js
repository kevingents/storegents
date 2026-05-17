// api/admin/store-weekly-order-report.js

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '12345';
const DEADLINE_HOURS = 48;
const PICK_PACK_MINUTES_PER_ORDER = 10;
const REPORT_STATUSES = ['accepted', 'pending', 'processed'];

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const token = String(req.headers['x-admin-token'] || req.headers.authorization || req.query.adminToken || req.query.admin_token || '').replace(/^Bearer\s+/i, '').trim();
  return token === ADMIN_TOKEN;
}

function clean(value) { return String(value ?? '').trim(); }
function firstFilled(...values) { for (const value of values) if (value !== undefined && value !== null && clean(value) !== '') return value; return ''; }
function pad(value) { return String(value).padStart(2, '0'); }

function isoWeek(dateInput) {
  const date = new Date(Date.UTC(dateInput.getUTCFullYear(), dateInput.getUTCMonth(), dateInput.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return { year: date.getUTCFullYear(), week: Math.ceil((((date - yearStart) / 86400000) + 1) / 7) };
}

function weekRange(year, week) {
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const day = simple.getUTCDay() || 7;
  const monday = new Date(simple);
  if (day <= 4) monday.setUTCDate(simple.getUTCDate() - day + 1);
  else monday.setUTCDate(simple.getUTCDate() + 8 - day);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const nextMonday = new Date(sunday);
  nextMonday.setUTCDate(sunday.getUTCDate() + 1);
  return { dateFrom: monday.toISOString().slice(0, 10), dateTo: sunday.toISOString().slice(0, 10), start: monday, end: nextMonday };
}

function selectedWeek(req) {
  const current = isoWeek(new Date());
  return { year: Math.max(2026, Number(req.query.year || current.year)), week: Math.min(53, Math.max(1, Number(req.query.week || current.week))) };
}

function inWeek(value, range) {
  const date = new Date(value || '');
  return !Number.isNaN(date.getTime()) && date >= range.start && date < range.end;
}

function hoursBetween(startValue, endValue) {
  const start = new Date(startValue || '');
  const end = new Date(endValue || Date.now());
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
  return Math.max(0, Math.round((end.getTime() - start.getTime()) / 36e5));
}

function isClosedStatus(value) {
  const status = clean(value).toLowerCase();
  return status.includes('processed') || status.includes('fulfilled') || status.includes('geleverd') || status.includes('afgerond');
}

function orderKey(item = {}) {
  return clean(firstFilled(item.orderNr, item.orderNumber, item.orderName, item.orderId, item.leveropdracht, item.deliveryOrder, item.fulfillmentId, item.id));
}

function lineKey(item = {}) {
  return clean(firstFilled(item.orderLineId, item.lineId, item.fulfillmentLineId, item.fulfillmentId, item.id, `${orderKey(item)}-${firstFilled(item.sku, item.barcode, item.articleNumber, item.artikelnummer)}`));
}

function normalizeFallback(item = {}) {
  const rawStore = firstFilled(item.currentStore, item.huidigFiliaalNaam, item.huidigFiliaal, item.currentBranchName, item.fulfilmentStore, item.fulfillmentStore, item.store, item.branchName);
  const currentStore = clean(rawStore).replace(/^\d+\s*-\s*/i, '');
  const createdAt = firstFilled(item.createdAt, item.orderDate, item.created, item.dateTime, item.datum);
  return { ...item, currentStore, createdAt, orderNr: orderKey(item), orderId: firstFilled(item.orderId, item.orderNr, item.orderNumber), quantity: Number(firstFilled(item.quantity, item.pieces, item.aantal, 1) || 1), status: firstFilled(item.status, item.srsStatus, item.lineStatus, item.fulfillmentStatus) };
}

function isNonStoreLine(item = {}) {
  const status = clean(item.status).toLowerCase();
  const store = clean(item.currentStore).toLowerCase();
  return status.includes('geannuleerd') || status.includes('cancel') || store.includes('klant') || store.includes('magazijn') || store.includes('warehouse') || store.includes('webshop');
}

async function readSrsReportFulfillments(req) {
  const [{ getFulfillments }, { listBranches, getStoreNameByBranchId }] = await Promise.all([
    import('../../lib/srs-weborders-message-client.js'),
    import('../../lib/branch-metrics.js')
  ]);

  const requestedStatuses = clean(req.query.statuses || '')
    ? clean(req.query.statuses).split(',').map((status) => clean(status)).filter(Boolean)
    : REPORT_STATUSES;

  const items = [];
  const errors = [];
  const branches = listBranches().map((branch) => String(branch.branchId)).filter(Boolean);

  for (const branchId of branches) {
    for (const status of requestedStatuses) {
      try {
        const result = await getFulfillments({ branchId, status });
        items.push(...(result.fulfillments || []).map((item) => normalizeFallback({
          ...item,
          currentStore: item.currentStore || item.fulfilmentStore || item.fulfillmentStore || getStoreNameByBranchId(branchId),
          fulfilmentStore: item.fulfilmentStore || getStoreNameByBranchId(branchId),
          fulfillmentStore: item.fulfillmentStore || getStoreNameByBranchId(branchId),
          branchId,
          status: item.status || status
        })));
      } catch (error) {
        errors.push({ branchId, status, message: error.message });
      }
    }
  }

  return {
    source: 'srs_get_fulfillments_multi_status',
    statuses: requestedStatuses,
    degraded: errors.length > 0,
    note: errors.length ? `${errors.length} SRS status/filiaal calls mislukt.` : '',
    errors: errors.slice(0, 20),
    items
  };
}

function getNormalizer() { return normalizeFallback; }

function buildRows(items, normalize, range) {
  const map = new Map();
  const debug = { totalInputItems: Array.isArray(items) ? items.length : 0, missingStore: 0, nonStoreLine: 0, missingDate: 0, outsideWeek: 0, includedLines: 0, sampleDates: [], sampleStores: [], statuses: {} };

  items.map(normalize).forEach((item) => {
    const store = clean(firstFilled(item.currentStore, item.huidigFiliaalNaam, item.fulfilmentStore, item.fulfillmentStore, item.store));
    const createdAt = firstFilled(item.createdAt, item.orderDate, item.created, item.dateTime, item.datum);
    const completedAt = firstFilled(item.completedAt, item.closedAt, item.fulfilledAt, item.updatedAt, item.updated, item.modifiedAt, isClosedStatus(item.status) ? item.updatedAt : '');
    const status = clean(item.status || 'unknown').toLowerCase() || 'unknown';
    debug.statuses[status] = (debug.statuses[status] || 0) + 1;

    if (store && debug.sampleStores.length < 10 && !debug.sampleStores.includes(store)) debug.sampleStores.push(store);
    if (createdAt && debug.sampleDates.length < 10 && !debug.sampleDates.includes(createdAt)) debug.sampleDates.push(createdAt);
    if (!store) { debug.missingStore += 1; return; }
    if (isNonStoreLine({ ...item, currentStore: store })) { debug.nonStoreLine += 1; return; }
    if (!createdAt) { debug.missingDate += 1; return; }
    if (!inWeek(createdAt, range)) { debug.outsideWeek += 1; return; }

    debug.includedLines += 1;
    if (!map.has(store)) map.set(store, { store, orderCount: 0, lateCount: 0, lineItemCount: 0, estimatedPickPackMinutes: 0, averagePickPackMinutes: PICK_PACK_MINUTES_PER_ORDER, oldestOpenOrder: '', oldestOpenAgeHours: 0, orders: new Set(), lateOrders: new Set(), lines: new Set() });

    const row = map.get(store);
    const order = orderKey(item) || lineKey(item);
    const line = lineKey(item) || order;
    const age = hoursBetween(createdAt, isClosedStatus(status) ? completedAt : new Date());

    if (!row.orders.has(order)) { row.orders.add(order); row.orderCount += 1; row.estimatedPickPackMinutes += PICK_PACK_MINUTES_PER_ORDER; }
    if (!row.lines.has(line)) { row.lines.add(line); row.lineItemCount += Number(item.quantity || 1); }
    if (age >= DEADLINE_HOURS) { row.lateOrders.add(order); row.lateCount = row.lateOrders.size; }
    if (age > row.oldestOpenAgeHours) { row.oldestOpenAgeHours = age; row.oldestOpenOrder = `${order} - ${age}u`; }
  });

  return { rows: Array.from(map.values()).map((row) => { const { orders, lateOrders, lines, ...safeRow } = row; return safeRow; }).sort((a, b) => b.orderCount - a.orderCount || b.lateCount - a.lateCount || a.store.localeCompare(b.store)), debug };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    /* dateFrom + dateTo (YYYY-MM-DD) overschrijven year/week wanneer beide aanwezig zijn. */
    const customFrom = String(req.query.dateFrom || '').slice(0,10);
    const customTo   = String(req.query.dateTo || '').slice(0,10);
    let year, week, range, scope;
    if (customFrom && customTo) {
      const startDate = new Date(`${customFrom}T00:00:00Z`);
      const endDate   = new Date(`${customTo}T23:59:59Z`);
      const nextDay   = new Date(endDate);
      nextDay.setUTCDate(endDate.getUTCDate() + 1);
      range = { dateFrom: customFrom, dateTo: customTo, start: startDate, end: nextDay };
      ({ year, week } = isoWeek(startDate));
      scope = 'custom-range';
    } else {
      const sel = selectedWeek(req);
      year = sel.year; week = sel.week;
      range = weekRange(year, week);
      scope = 'iso-week';
    }
    const srs = await readSrsReportFulfillments(req);
    const built = buildRows(Array.isArray(srs.items) ? srs.items : [], getNormalizer(), range);
    const rows = built.rows;
    const totals = rows.reduce((sum, row) => { sum.orderCount += Number(row.orderCount || 0); sum.lateCount += Number(row.lateCount || 0); sum.lineItemCount += Number(row.lineItemCount || 0); sum.estimatedPickPackMinutes += Number(row.estimatedPickPackMinutes || 0); return sum; }, { orderCount: 0, lateCount: 0, lineItemCount: 0, estimatedPickPackMinutes: 0, storeCount: rows.length });
    totals.storeCount = rows.length;

    const payload = { success: true, year, week, weekLabel: `${year}-W${pad(week)}`, dateFrom: range.dateFrom, dateTo: range.dateTo, scope, source: 'srs_get_fulfillments_multi_status', sourceDetail: srs.source || '', statuses: srs.statuses, degraded: Boolean(srs.degraded), note: srs.note || 'Telling op SRS Huidig filiaal per orderregel inclusief open en verwerkte fulfillments.', ownerLogic: 'order-line-current-branch', deadlineHours: DEADLINE_HOURS, pickPackMinutesPerOrder: PICK_PACK_MINUTES_PER_ORDER, totals, rows, updatedAt: new Date().toISOString() };
    if (String(req.query.debug || '') === '1') payload.debug = { ...built.debug, srsErrors: srs.errors || [] };
    return res.status(200).json(payload);
  } catch (error) {
    console.error('[admin/store-weekly-order-report]', error);
    return res.status(error.status || 500).json({ success: false, source: 'srs_get_fulfillments_multi_status', message: error.message || 'SRS weekrapport kon niet worden opgebouwd.' });
  }
}
