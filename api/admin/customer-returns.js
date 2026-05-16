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

  if (!orderIds.length && !orderNrs.length) {
    return res.status(400).json({
      success: false,
      message: 'Geef orderIds of orderNrs op om te tellen.'
    });
  }

  try {
    const logs = await getSrsReturnLogs();
    const idSet = new Set(orderIds.map(String));
    const nrSet = new Set(orderNrs.map((nr) => String(nr).replace(/^#/, '')));

    const matches = (Array.isArray(logs) ? logs : []).filter((log) => {
      const shopId = String(log.shopifyOrderId || '');
      const orderNr = String(log.orderNr || '').replace(/^#/, '');
      return (shopId && idSet.has(shopId)) || (orderNr && nrSet.has(orderNr));
    });

    const items = matches.map((log) => ({
      id: log.id,
      orderNr: log.orderNr || '',
      store: log.store || '',
      status: log.status || '',
      success: Boolean(log.success),
      createdAt: log.createdAt || '',
      crossSellMade: Boolean(log.crossSellMade),
      crossSellAmount: Number(log.crossSellAmount || 0) || 0
    }));

    return res.status(200).json({
      success: true,
      count: items.length,
      successCount: items.filter((item) => item.success).length,
      crossSellCount: items.filter((item) => item.crossSellMade).length,
      crossSellTotal: items.reduce((sum, item) => sum + item.crossSellAmount, 0),
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
