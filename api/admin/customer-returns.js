import { getSrsReturnLogs } from '../../lib/srs-return-log-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(
    req.headers['x-admin-token'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).trim();
  return token === adminToken;
}

function normalizeIds(value) {
  return String(value || '')
    .split(',')
    .map((id) => String(id || '').trim())
    .filter(Boolean);
}

/**
 * Telt retouren per klant op basis van order-ids of order-nummers.
 *
 * Query parameters (één is verplicht):
 *   - orderIds: comma-separated Shopify order ids (matched op shopifyOrderId)
 *   - orderNrs: comma-separated SRS/order nummers (matched op orderNr)
 *
 * Returns:
 *   { success, count, successCount, items: [{ id, orderNr, store, status, success, createdAt, crossSellMade, crossSellAmount }] }
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  const orderIds = normalizeIds(req.query.orderIds);
  const orderNrs = normalizeIds(req.query.orderNrs);
  const customerEmail = String(req.query.customerEmail || req.query.email || '').trim().toLowerCase();
  const customerId = String(req.query.customerId || '').trim();
  const daysWindow = Math.max(0, Math.min(3650, Number(req.query.days || 0) || 0));

  if (!orderIds.length && !orderNrs.length && !customerEmail && !customerId) {
    return res.status(400).json({
      success: false,
      message: 'Geef orderIds, orderNrs, customerEmail of customerId op om te tellen.'
    });
  }

  try {
    const logs = await getSrsReturnLogs();
    const idSet = new Set(orderIds.map(String));
    const nrSet = new Set(orderNrs.map((nr) => String(nr).replace(/^#/, '')));
    const cutoff = daysWindow > 0 ? Date.now() - daysWindow * 24 * 60 * 60 * 1000 : 0;

    const matches = (Array.isArray(logs) ? logs : []).filter((log) => {
      /* Datum-filter */
      if (cutoff && log.createdAt && new Date(log.createdAt).getTime() < cutoff) return false;

      const shopId = String(log.shopifyOrderId || '');
      const orderNr = String(log.orderNr || '').replace(/^#/, '');
      const logEmail = String(log.customerEmail || '').toLowerCase();
      const logCustomerId = String(log.customerId || '');

      if (idSet.size && shopId && idSet.has(shopId)) return true;
      if (nrSet.size && orderNr && nrSet.has(orderNr)) return true;
      if (customerEmail && logEmail && logEmail === customerEmail) return true;
      if (customerId && logCustomerId && logCustomerId === customerId) return true;
      return false;
    });

    /* Sorteer nieuwste eerst voor frontend rendering */
    matches.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const items = matches.map((log) => ({
      id: log.id,
      orderNr: log.orderNr || '',
      shopifyOrderId: log.shopifyOrderId || '',
      store: log.store || '',
      status: log.status || '',
      success: Boolean(log.success),
      createdAt: log.createdAt || '',
      crossSellMade: Boolean(log.crossSellMade),
      crossSellAmount: Number(log.crossSellAmount || 0) || 0,
      reason: log.reason || '',
      refundAmount: Number(log.refundAmount || 0) || 0,
      itemCount: Array.isArray(log.items) ? log.items.length : 0
    }));

    return res.status(200).json({
      success: true,
      count: items.length,
      successCount: items.filter((item) => item.success).length,
      crossSellCount: items.filter((item) => item.crossSellMade).length,
      crossSellTotal: items.reduce((sum, item) => sum + item.crossSellAmount, 0),
      refundTotal: items.reduce((sum, item) => sum + item.refundAmount, 0),
      items
    });
  } catch (error) {
    console.error('[admin/customer-returns]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Retouren konden niet worden opgehaald.'
    });
  }
}
