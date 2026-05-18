/**
 * GET /api/notifications/unread?store=<store>
 *
 * Voor winkel-polling. Returnt ongelezen notificaties + count.
 * Geen admin-token nodig — winkel-context volstaat.
 */

import { listForStore } from '../../lib/store-notifications-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = String(req.query.store || '').trim();
  if (!store) return res.status(400).json({ success: false, message: 'store query-param is verplicht.' });

  try {
    const items = await listForStore(store, { limit: 50, includeRead: false });
    return res.status(200).json({ success: true, count: items.length, notifications: items });
  } catch (error) {
    console.error('[notifications/unread]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
