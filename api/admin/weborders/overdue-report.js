import { getSrsOpenWeborders } from '../../../lib/srs-open-weborders-client.js';
import { summarizeOverdueByStore, normalizeWeborder, isOpenWeborderStatus } from '../../../lib/weborder-request-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

function emptyPayload(note = '') {
  return {
    success: true,
    degraded: true,
    source: 'safe_empty_fallback',
    note,
    deadlineHours: 48,
    totals: {
      openCount: 0,
      overdueCount: 0,
      storeCount: 0
    },
    rows: []
  };
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
      source: result.source || 'srs_open_weborders',
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
    console.error('Overdue weborders report safe fallback:', error);
    return res.status(200).json(emptyPayload(
      error.message || 'Openstaande weborders konden niet worden opgehaald. Lege fallback gebruikt zodat de admin blijft laden.'
    ));
  }
}
