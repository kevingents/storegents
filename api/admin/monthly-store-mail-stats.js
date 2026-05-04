import { getMailLog, monthlyStats } from '../../lib/gents-mail-log-store.js';
import { getAdminToken } from '../../lib/gents-mail-config.js';

function hasAdmin(req) {
  const expected = getAdminToken();
  if (!expected) return true;
  const header = String(req.headers['x-admin-token'] || '').trim();
  const query = String(req.query.adminToken || req.query.token || '').trim();
  const auth = String(req.headers.authorization || '');
  const bearer = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
  return [header, query, bearer].includes(expected);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  if (!hasAdmin(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const now = new Date();
  const dateFrom = req.query.dateFrom || new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const dateTo = req.query.dateTo || now.toISOString();
  const rows = await getMailLog();
  const stats = monthlyStats(rows, dateFrom, dateTo);

  return res.status(200).json({
    success: true,
    dateFrom,
    dateTo,
    count: stats.length,
    rows: stats,
    totals: stats.reduce((acc, row) => {
      acc.total += row.total;
      acc.weborderOverdue += row.weborderOverdue;
      acc.weborderRegionManager += row.weborderRegionManager;
      acc.pickupNew += row.pickupNew;
      acc.pickupReminder += row.pickupReminder;
      acc.errors += row.errors;
      return acc;
    }, { total: 0, weborderOverdue: 0, weborderRegionManager: 0, pickupNew: 0, pickupReminder: 0, errors: 0 })
  });
}
