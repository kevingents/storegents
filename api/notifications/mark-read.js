/**
 * POST /api/notifications/mark-read
 * Body: { store, ids: ['id1', ...] | 'all' }
 */

import { markRead, markAllRead } from '../../lib/store-notifications-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  const body = parseBody(req);
  const store = String(body.store || '').trim();
  if (!store) return res.status(400).json({ success: false, message: 'store is verplicht.' });

  try {
    let count;
    if (body.ids === 'all') {
      count = await markAllRead(store);
    } else if (Array.isArray(body.ids)) {
      count = await markRead(store, body.ids);
    } else {
      return res.status(400).json({ success: false, message: 'ids array of "all" verplicht.' });
    }
    return res.status(200).json({ success: true, marked: count });
  } catch (error) {
    console.error('[notifications/mark-read]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
