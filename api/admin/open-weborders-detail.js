import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { DEFAULT_STORE_NAMES, getApiBaseUrl, splitList } from '../../lib/gents-mail-config.js';

/**
 * GET /api/admin/open-weborders-detail
 *
 * Combineert open weborders van ALLE winkels in 1 lijst.
 * Voor elke winkel parallel een /api/srs/open-weborders?store=X call.
 * Resultaat genormaliseerd voor admin orders-tabel.
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

  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const base = getApiBaseUrl(req);
  const stores = splitList(process.env.GENTS_STORES_LIST || '')
    .filter(s => s && s.toLowerCase() !== 'gents administratie')
    .length
      ? splitList(process.env.GENTS_STORES_LIST || '').filter(s => s && s.toLowerCase() !== 'gents administratie')
      : DEFAULT_STORE_NAMES.filter(s => s && s !== 'GENTS Brandstores');

  const startedAt = Date.now();

  /* Parallel fetch */
  const results = await Promise.all(stores.map(async (store) => {
    try {
      const u = new URL(`${base}/api/srs/open-weborders`);
      u.searchParams.set('store', store);
      u.searchParams.set('t', Date.now());
      const r = await fetch(u.toString(), {
        headers: { 'x-admin-token': adminToken, Accept: 'application/json' }
      });
      if (!r.ok) return { store, error: `HTTP ${r.status}`, items: [] };
      const d = await r.json();
      const items = d.requests || d.items || d.openOrders || [];
      return { store, items, summary: d.summary || null };
    } catch (e) {
      return { store, error: e.message || 'fetch failed', items: [] };
    }
  }));

  const orders = [];
  results.forEach(({ store, items }) => {
    (items || []).forEach((it) => {
      orders.push(normalizeOrder(it, store));
    });
  });

  /* Compute totals + per-store summary */
  const perStore = stores.map((store) => {
    const r = results.find(x => x.store === store) || { items: [] };
    const its = r.items || [];
    const open = its.length;
    const overdue = its.filter(x => isOverdue(x)).length;
    return { store, openCount: open, overdueCount: overdue, error: r.error || null };
  });

  const totals = {
    totalOpen: orders.length,
    totalOverdue: orders.filter(o => o.isLate).length,
    totalWarning: orders.filter(o => o.isWarn).length,
    storeCount: perStore.filter(p => p.openCount > 0).length,
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
    orders
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
