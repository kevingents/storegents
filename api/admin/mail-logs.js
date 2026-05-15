import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getMailLog, monthlyStats } from '../../lib/gents-mail-log-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const type = String(req.query.type || '').trim().toLowerCase();
  const store = String(req.query.store || '').trim().toLowerCase();
  const status = String(req.query.status || '').trim().toLowerCase();
  const search = String(req.query.search || '').trim().toLowerCase();
  const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 200)));
  const statsOnly = String(req.query.stats || '') === '1';

  const logs = await getMailLog();

  if (statsOnly) {
    const from = req.query.from || '';
    const to = req.query.to || '';
    return res.status(200).json({ success: true, stats: monthlyStats(logs, from, to) });
  }

  const rows = logs.filter((log) => {
    if (type && String(log.type || '').toLowerCase() !== type) return false;
    if (store && !String(log.store || '').toLowerCase().includes(store)) return false;
    if (status && String(log.status || '').toLowerCase() !== status) return false;
    if (search) {
      const haystack = [log.store, log.type, log.recipient, log.order, log.key, log.message, log.resendId].join(' ').toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  }).slice(0, limit);

  const totals = {
    total: rows.length,
    sent: rows.filter((r) => r.status === 'sent').length,
    error: rows.filter((r) => r.status === 'error').length,
    dryRun: rows.filter((r) => r.status === 'dry_run').length
  };

  return res.status(200).json({ success: true, count: rows.length, totals, logs: rows });
}
