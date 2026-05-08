// api/admin/store-weekly-order-report.js

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '12345';
const DEADLINE_HOURS = 48;
const PICK_PACK_MINUTES_PER_ORDER = 10;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, x-admin-token, x-admin-pin, authorization'
  );
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  return token === ADMIN_TOKEN;
}

function clean(value) {
  return String(value ?? '').trim();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return '';
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function isoWeek(dateInput) {
  const date = new Date(Date.UTC(
    dateInput.getUTCFullYear(),
    dateInput.getUTCMonth(),
    dateInput.getUTCDate()
  ));

  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);

  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);

  return {
    year: date.getUTCFullYear(),
    week
  };
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

  return {
    dateFrom: monday.toISOString().slice(0, 10),
    dateTo: sunday.toISOString().slice(0, 10),
    start: monday,
    end: nextMonday
  };
}

function selectedWeek(req) {
  const current = isoWeek(new Date());

  return {
    year: Math.max(2026, Number(req.query.year || current.year)),
    week: Math.min(53, Math.max(1, Number(req.query.week || current.week)))
  };
}

function inWeek(value, range) {
  const date = new Date(value || '');
  return !Number.isNaN(date.getTime()) && date >= range.start && date < range.end;
}

function hoursSince(value) {
  const date = new Date(value || '');
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 36e5));
}

function orderKey(item = {}) {
  return clean(firstFilled(
    item.orderNr,
    item.orderNumber,
    item.orderName,
    item.orderId,
    item.leveropdracht,
    item.deliveryOrder,
    item.fulfillmentId,
    item.id
  ));
}

function lineKey(item = {}) {
  return clean(firstFilled(
    item.orderLineId,
    item.lineId,
    item.fulfillmentLineId,
    item.fulfillmentId,
    item.id,
    `${orderKey(item)}-${firstFilled(item.sku, item.barcode, item.articleNumber, item.artikelnummer)}`
  ));
}

function normalizeFallback(item = {}) {
  const rawStore = firstFilled(
    item.currentStore,
    item.huidigFiliaalNaam,
    item.huidigFiliaal,
    item.currentBranchName,
    item.fulfilmentStore,
    item.fulfillmentStore,
    item.store,
    item.branchName
  );

  const currentStore = clean(rawStore).replace(/^\d+\s*-\s*/i, '');
  const createdAt = firstFilled(
    item.createdAt,
    item.orderDate,
    item.created,
    item.dateTime,
    item.datum
  );

  return {
    ...item,
    currentStore,
    createdAt,
    orderNr: orderKey(item),
    orderId: firstFilled(item.orderId, item.orderNr, item.orderNumber),
    quantity: Number(firstFilled(item.quantity, item.pieces, item.aantal, 1) || 1),
    status: firstFilled(item.status, item.srsStatus, item.lineStatus, item.fulfillmentStatus)
  };
}

function closedOrNotStoreLine(item = {}) {
  const status = clean(item.status).toLowerCase();
  const store = clean(item.currentStore).toLowerCase();

  return (
    status.includes('geleverd') ||
    status.includes('afgerond') ||
    status.includes('geannuleerd') ||
    status.includes('cancel') ||
    status.includes('closed') ||
    store.includes('klant') ||
    store.includes('magazijn') ||
    store.includes('warehouse') ||
    store.includes('webshop') ||
    store.includes('geleverd')
  );
}

async function readSrsOpenWeborders() {
  const client = await import('../../../lib/srs-open-weborders-client.js');

  if (typeof client.getSrsOpenWeborders !== 'function') {
    throw new Error('SRS open-weborders client ontbreekt.');
  }

  return client.getSrsOpenWeborders({});
}

async function getNormalizer() {
  try {
    const helpers = await import('../../../lib/weborder-request-store.js');
    return helpers.normalizeWeborder || normalizeFallback;
  } catch (_error) {
    return normalizeFallback;
  }
}

function buildRows(items, normalize, range) {
  const map = new Map();

  items.map(normalize).forEach((item) => {
    const store = clean(firstFilled(
      item.currentStore,
      item.huidigFiliaalNaam,
      item.fulfilmentStore,
      item.fulfillmentStore,
      item.store
    ));

    const createdAt = firstFilled(
      item.createdAt,
      item.orderDate,
      item.created,
      item.dateTime,
      item.datum
    );

    if (!store) return;
    if (closedOrNotStoreLine({ ...item, currentStore: store })) return;
    if (!inWeek(createdAt, range)) return;

    if (!map.has(store)) {
      map.set(store, {
        store,
        orderCount: 0,
        lateCount: 0,
        lineItemCount: 0,
        estimatedPickPackMinutes: 0,
        averagePickPackMinutes: PICK_PACK_MINUTES_PER_ORDER,
        oldestOpenOrder: '',
        oldestOpenAgeHours: 0,
        orders: new Set(),
        lateOrders: new Set(),
        lines: new Set()
      });
    }

    const row = map.get(store);
    const order = orderKey(item) || lineKey(item);
    const line = lineKey(item) || order;
    const age = hoursSince(createdAt);

    if (!row.orders.has(order)) {
      row.orders.add(order);
      row.orderCount += 1;
      row.estimatedPickPackMinutes += PICK_PACK_MINUTES_PER_ORDER;
    }

    if (!row.lines.has(line)) {
      row.lines.add(line);
      row.lineItemCount += Number(item.quantity || 1);
    }

    if (age >= DEADLINE_HOURS) {
      row.lateOrders.add(order);
      row.lateCount = row.lateOrders.size;
    }

    if (age > row.oldestOpenAgeHours) {
      row.oldestOpenAgeHours = age;
      row.oldestOpenOrder = `${order} - ${age}u`;
    }
  });

  return Array.from(map.values())
    .map((row) => {
      const { orders, lateOrders, lines, ...safeRow } = row;
      return safeRow;
    })
    .sort((a, b) =>
      b.orderCount - a.orderCount ||
      b.lateCount - a.lateCount ||
      a.store.localeCompare(b.store)
    );
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  try {
    const { year, week } = selectedWeek(req);
    const range = weekRange(year, week);

    const [srs, normalize] = await Promise.all([
      readSrsOpenWeborders(),
      getNormalizer()
    ]);

    const rows = buildRows(
      Array.isArray(srs.items) ? srs.items : [],
      normalize,
      range
    );

    const totals = rows.reduce((sum, row) => {
      sum.orderCount += Number(row.orderCount || 0);
      sum.lateCount += Number(row.lateCount || 0);
      sum.lineItemCount += Number(row.lineItemCount || 0);
      sum.estimatedPickPackMinutes += Number(row.estimatedPickPackMinutes || 0);
      return sum;
    }, {
      orderCount: 0,
      lateCount: 0,
      lineItemCount: 0,
      estimatedPickPackMinutes: 0,
      storeCount: rows.length
    });

    totals.storeCount = rows.length;

    return res.status(200).json({
      success: true,
      year,
      week,
      weekLabel: `${year}-W${pad(week)}`,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      source: 'srs_open_weborders',
      sourceDetail: srs.source || '',
      degraded: Boolean(srs.degraded),
      note: srs.note || 'Telling op SRS Huidig filiaal per orderregel.',
      ownerLogic: 'order-line-current-branch',
      deadlineHours: DEADLINE_HOURS,
      pickPackMinutesPerOrder: PICK_PACK_MINUTES_PER_ORDER,
      totals,
      rows,
      updatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[admin/store-weekly-order-report]', error);

    return res.status(error.status || 500).json({
      success: false,
      source: 'srs_open_weborders',
      message: error.message || 'SRS weekrapport kon niet worden opgebouwd.'
    });
  }
}
