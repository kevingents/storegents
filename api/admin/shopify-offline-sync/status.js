import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { readSyncState, readSyncHistory, summarizeSyncHistory } from '../../../lib/shopify-offline-sync.js';

/**
 * GET /api/admin/shopify-offline-sync/status
 *
 * Status + history van de offline-sync cron, voor monitoring-pagina.
 *
 * Response:
 *   {
 *     success,
 *     state: { lastRunAt, lastSuccessAt, ... },
 *     stats: { totalRuns, runsLast24h, ordersLast7d, ... },
 *     recentRuns: [
 *       { at, success, durationMs, createdOrders, errors, message, ... }
 *     ]
 *   }
 */

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const state = await readSyncState();
    const history = await readSyncHistory();
    const runs = Array.isArray(history.runs) ? history.runs : [];
    const stats = summarizeSyncHistory(runs);

    /* Verzamel meest voorkomende error-messages over laatste 7 dagen */
    const last7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const errorCounts = new Map();
    for (const run of runs) {
      const t = new Date(run.at || 0).getTime();
      if (t < last7d) continue;
      for (const err of (run.errorDetails || [])) {
        const msg = String(err.message || '').slice(0, 200);
        if (!msg) continue;
        errorCounts.set(msg, (errorCounts.get(msg) || 0) + 1);
      }
    }
    const topErrors = Array.from(errorCounts.entries())
      .map(([message, count]) => ({ message, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return res.status(200).json({
      success: true,
      state,
      stats,
      topErrors,
      recentRuns: runs.slice(0, 50),
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[admin/shopify-offline-sync/status] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Status ophalen mislukt.'
    });
  }
}
