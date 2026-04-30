import { getSrsOpenWeborders } from '../../lib/srs-open-weborders-client.js';
import { summarizeOpenWeborders, normalizeWeborder } from '../../lib/weborder-request-store.js';
import { getBranchIdByStore } from '../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const store = String(req.query.store || '').trim();
    const branchId = String(req.query.branchId || getBranchIdByStore(store) || '').trim();
    const result = await getSrsOpenWeborders({ store, branchId });
    const items = (result.items || []).map(normalizeWeborder);
    const summary = store ? summarizeOpenWeborders(items, store) : null;

    return res.status(200).json({
      success: true,
      source: result.source,
      note: result.note || '',
      degraded: Boolean(result.degraded),
      store,
      branchId,
      deadlineHours: 48,
      summary: summary || {
        store,
        sellingOpenCount: 0,
        fulfilmentOpenCount: 0,
        overdueCount: 0,
        totalOpenCount: 0,
        sellingOpen: [],
        fulfilmentOpen: [],
        overdue: []
      },
      open: summary?.totalOpenCount || 0,
      overdue: summary?.overdueCount || 0,
      requests: store ? items.filter((item) => item.sellingStore === store || item.fulfilmentStore === store).slice(0, 200) : items.slice(0, 500)
    });
  } catch (error) {
    console.error('SRS open weborders error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Open weborders konden niet worden opgehaald.'
    });
  }
}
