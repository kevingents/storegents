/**
 * GET /api/admin/spotler-metrics
 *
 * Geeft de gecachte Spotler e-mailmarketing-metrics terug (snel). Met
 * ?refresh=1 wordt live opgehaald (kan 10–40s duren). De dagelijkse cron
 * houdt de cache warm.
 *
 * Auth: admin-token vereist.
 */

import { readSpotlerMetrics, refreshSpotlerMetrics } from '../../lib/spotler-metrics.js';
import { hasSpotlerCreds } from '../../lib/spotler-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (!hasSpotlerCreds()) {
    return res.status(200).json({ success: true, connected: false, rows: [], totals: null, message: 'Spotler niet gekoppeld (SPOTLER_CONSUMER_KEY/SECRET ontbreken).' });
  }

  try {
    const refresh = String(req.query?.refresh || '') === '1';
    if (refresh) {
      const data = await refreshSpotlerMetrics();
      return res.status(200).json({ success: true, ...data });
    }
    const cached = await readSpotlerMetrics();
    if (cached) return res.status(200).json({ success: true, ...cached });
    /* Geen cache → niet inline ophalen (houd UI snel); melden dat het nog moet. */
    return res.status(200).json({ success: true, connected: true, rows: [], totals: null, stale: true, refreshedAt: null });
  } catch (e) {
    console.error('[admin/spotler-metrics]', e);
    return res.status(500).json({ success: false, message: e.message || 'Spotler-metrics mislukt.' });
  }
}
