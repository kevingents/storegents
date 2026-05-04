import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getMailLogs } from '../../lib/mail-log-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const type = String(req.query.type || '').trim().toLowerCase();
  const store = String(req.query.store || '').trim().toLowerCase();
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const logs = await getMailLogs();
  const rows = logs.filter((log) => {
    if (type && String(log.type || '').toLowerCase() !== type) return false;
    if (store && String(log.store || '').toLowerCase() !== store) return false;
    return true;
  }).slice(0, limit);

  return res.status(200).json({ success: true, count: rows.length, logs: rows });
}
