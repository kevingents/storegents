/**
 * Cron: GET /api/cron/spotler-metrics-refresh
 * Schedule: '45 5 * * *'
 *
 * Vernieuwt de gecachte Spotler e-mailmarketing-metrics (mailings + stats).
 * Handmatig: ?adminToken=… of x-admin-token header.
 */

import { refreshSpotlerMetrics } from '../../lib/spotler-metrics.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

export const maxDuration = 60;

function isAuthorized(req) {
  return isCronAuthorized(req);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const d = await refreshSpotlerMetrics();
    return res.status(200).json({
      success: true,
      connected: d.connected,
      mailings: d.rows ? d.rows.length : 0,
      refreshedAt: d.refreshedAt
    });
  } catch (e) {
    console.error('[cron/spotler-metrics-refresh]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('spotler-metrics-refresh', handler);
