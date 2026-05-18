/**
 * GET /api/notifications/list?store=<store>&limit=50
 *
 * Volledige historie (gelezen + ongelezen) voor het notification-center.
 */

import { listForStore } from '../../lib/store-notifications-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = String(req.query.store || '').trim();
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  if (!store) return res.status(400).json({ success: false, message: 'store is verplicht.' });

  try {
    const items = await listForStore(store, { limit, includeRead: true });
    return res.status(200).json({ success: true, count: items.length, notifications: items });
  } catch (error) {
    console.error('[notifications/list]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
