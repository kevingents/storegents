import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { DEFAULT_STORE_NAMES, splitList } from '../../lib/gents-mail-config.js';

/**
 * GET /api/admin/open-weborders-detail
 *
 * Haalt direct SRS open weborders op (1x globaal of via parallel store-queries)
 * en categoriseert elk item:
 *   - 'store'    = open bij een winkel voor pick & pack
 *   - 'pipeline' = bij magazijn / showroom / uitlevertafel
 *   - skipped    = delivered, geannuleerd, gesloten
 *
 * Cache: 5 min in-memory.
 */

let MEMORY_CACHE = { ts: 0, data: null };
const CACHE_TTL_MS = 5 * 60 * 1000;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const force = String(req.query.refresh || '') === '1';
  if (!force && MEMORY_CACHE.data && (Date.now() - MEMORY_CACHE.ts) < CACHE_TTL_MS) {
    return res.status(200).json({ ...MEMORY_CACHE.data, cached: true, cacheAgeMs: Date.now() - MEMORY_CACHE.ts });
  }

  const stores = (() => {
    const env = splitList(process.env.GENTS_STORES_LIST || '').filter(s => s && s.toLowerCase() !== 'gents administratie');
    return env.length ? env : DEFAULT_STORE_NAMES.filter(s => s && s !== 'GENTS Brandstores');
  })();

  const startedAt = Date.now();

  let normalizeWeborder, isOpenWeborderStatus, isClosedWeborderStatus, getSrsOpenWeborders;
  try {
    const helpers = await import('../../lib/weborder-request-store.js');
    normalizeWeborder = helpers.normalizeWeborder;
    isOpenWeborderStatus = helpers.isOpenWeborderStatus;
    isClosedWeborderStatus = helpers.isClosedWeborderStatus;
    const client = await import('../../lib/srs-open-weborders-client.js');
    getSrsOpenWeborders = client.getSrsOpenWeborders;
  } catch (e) {
    return res.status(200).json({ success: false, message: e.message || 'Lib import failed.', totals: {}, perStore: [], orders: [] });
  }

  /* Parallel fetch SRS per winkel — krijgt ALLE items (filter wordt hier toegepast) */
  const fetched = await Promise.all(stores.map(async (store) => {
    try {
      const r = await getSrsOpenWeborders({ store });
      return { store, items: r.items || [], error: r.degraded ? (r.note || '') : null };
    } catch (e) {
      return { store, items: [], error: e.message || 'fetch failed' };
    }
  }));

  const ordersStore = [];
  const ordersPipeline = [];
  const seenKeys = new Set(); /* dedupe across stores (zelfde order kan bij multiple branches voorkomen) */

  fetched.forEach(({ store, items }) => {
    items.forEach((raw) => {
      const item = normalizeWeborder(raw);
      if (isClosedWeborderStatus(item.status)) return;
      if (item.delivered) return;
      if (!isOpenWeborderStatus(item.status)) return;
      const key = `${item.orderNr || item.id}-${item.orderLineId || ''}-${item.currentBranchId || ''}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);

      const ord = normalizeOrder(item, store);
      if (item.warehouse) {
        ord.location = 'magazijn';
        ordersPipeline.push(ord);
      } else if (/showroom/i.test(item.currentStore || '') || /showroom/i.test(item.currentLocationRaw || '')) {
        ord.location = 'showroom';
        ordersPipeline.push(ord);
      } else if (/uitlevertafel/i.test(item.currentLocationRaw || '')) {
        ord.location = 'uitlevertafel';
        ordersPipeline.push(ord);
      } else {
        ord.location = 'winkel';
        ordersStore.push(ord);
      }
    });
  });

  /* Per-store summary */
  const storeMap = new Map();
  ordersStore.forEach(o => {
    const cur = storeMap.get(o.store) || { store: o.store, openCount: 0, overdueCount: 0 };
    cur.openCount++;
    if (o.isLate) cur.overdueCount++;
    storeMap.set(o.store, cur);
  });
  const perStore = stores.map(s => storeMap.get(s) || { store: s, openCount: 0, overdueCount: 0 });

  /* Pipeline split */
  const pipelineSplit = {
    magazijn: ordersPipeline.filter(o => o.location === 'magazijn').length,
    showroom: ordersPipeline.filter(o => o.location === 'showroom').length,
    uitlevertafel: ordersPipeline.filter(o => o.location === 'uitlevertafel').length
  };

  const totals = {
    totalOpen: ordersStore.length,
    totalOverdue: ordersStore.filter(o => o.isLate).length,
    totalWarning: ordersStore.filter(o => o.isWarn).length,
    storeCount: perStore.filter(p => p.openCount > 0).length,
    pipelineTotal: ordersPipeline.length,
    pipelineSplit,
    fetchedStores: stores.length,
    fetchDurationMs: Date.now() - startedAt
  };

  const payload = {
    success: true,
    source: 'admin_open_weborders_detail',
    cached: false,
    generatedAt: new Date().toISOString(),
    totals,
    perStore,
    orders: ordersStore,
    pipeline: ordersPipeline
  };

  MEMORY_CACHE = { ts: Date.now(), data: payload };
  return res.status(200).json(payload);
}

function normalizeOrder(item, store) {
  const orderName = item.orderName || item.orderNumber || item.name || item.order || '';
  const customerName = item.customerName
    || [item.customerFirstName, item.customerLastName].filter(Boolean).join(' ')
    || item.customer || '';
  const email = item.email || item.customerEmail || '';
  const created = item.orderDate || item.createdAt || item.openDate || item.created || '';
  const ageHours = computeAgeHours(created);
  const total = Number(item.totalPrice || item.totalAmount || item.total || 0);
  const itemCount = Number(item.itemCount || item.lineItemCount || item.lineCount || (Array.isArray(item.lines) ? item.lines.length : 1));
  const channel = inferChannel(item);
  const status = String(item.status || item.fulfillmentStatus || 'Open');
  const isLate = isOverdue(item) || ageHours >= 48;
  const isWarn = !isLate && ageHours >= 24;
  const priority = inferPriority(item, ageHours);

  return {
    orderName: orderName ? (String(orderName).startsWith('#') ? orderName : `#${orderName}`) : '',
    customerName: customerName || 'Onbekend',
    email,
    store,
    channel,
    date: created,
    ageHours,
    itemCount,
    total,
    status,
    priority,
    isLate, isWarn,
    nextAction: pickNextAction(ageHours, isLate),
    nextActionTime: pickNextActionTime(ageHours),
    raw: { orderId: item.orderId || item.id, lines: item.lines || item.lineItems || [] }
  };
}

function computeAgeHours(dateLike) {
  if (!dateLike) return 0;
  const dt = new Date(dateLike);
  if (Number.isNaN(dt.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - dt.getTime()) / 3.6e6));
}

function isOverdue(item) {
  if (item.overdue === true) return true;
  if (item.isOverdue === true) return true;
  const ageHours = computeAgeHours(item.orderDate || item.createdAt || item.openDate);
  return ageHours >= 48;
}

function inferChannel(item) {
  const source = String(item.source || item.channel || '').toLowerCase();
  if (source.includes('shopify')) return 'Shopify';
  if (source.includes('srs') || source.includes('web')) return 'SRS';
  return 'SRS';
}

function inferPriority(item, ageHours) {
  if (item.priority) return String(item.priority);
  if (ageHours >= 168) return 'Hoog';   /* 7d+ */
  if (ageHours >= 48) return 'Hoog';
  if (ageHours >= 24) return 'Normaal';
  return 'Normaal';
}

function pickNextAction(ageHours, isLate) {
  if (ageHours >= 168) return 'Escaleer klantcontact';
  if (isLate) return 'Contact klant';
  if (ageHours >= 24) return 'Pick & pack uitlevertafel';
  return 'Normale pick & pack';
}

function pickNextActionTime(ageHours) {
  if (ageHours >= 48) return 'Vandaag urgent';
  if (ageHours >= 24) return 'Vandaag';
  const today = new Date();
  return `Vandaag ${String(today.getHours()).padStart(2, '0')}:00`;
}
