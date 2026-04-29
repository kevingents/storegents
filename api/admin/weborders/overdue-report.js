import { getSrsOpenWeborders } from '../../../lib/srs-open-weborders-client.js';
import { summarizeOverdueByStore, normalizeWeborder, isOpenWeborderStatus } from '../../../lib/weborder-request-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const result = await getSrsOpenWeborders({});
    const items = (result.items || []).map(normalizeWeborder);
    const openItems = items.filter((item) => isOpenWeborderStatus(item.status));
    const rows = summarizeOverdueByStore(items);
    const overdueItems = rows.flatMap((row) => row.items || []);

    return res.status(200).json({
      success: true,
      source: result.source,
      note: result.note || '',
      degraded: Boolean(result.degraded),
      deadlineHours: 48,
      totals: {
        openCount: openItems.length,
        overdueCount: overdueItems.length,
        storeCount: rows.length
      },
      rows
    });
  } catch (error) {
    console.error('Overdue weborders report error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Weborder deadline rapportage kon niet worden opgehaald.'
    });
  }
}
