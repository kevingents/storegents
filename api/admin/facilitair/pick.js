/**
 * POST /api/admin/facilitair/pick
 *
 * Admin vinkt een product binnen een bestelling af tijdens het picken.
 * Body: { orderId, productId, picked: true|false, actor }
 */

import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { togglePickedItem } from '../../../lib/facilitair-orders-store.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const order = await togglePickedItem(body.orderId, body.productId, Boolean(body.picked), body.actor || 'admin');
    return res.status(200).json({ success: true, order });
  } catch (error) {
    return res.status(400).json({ success: false, message: error.message || 'Pick-update mislukt.' });
  }
}
