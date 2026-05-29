/**
 * Cron: GET /api/cron/srs-retail-import
 * Schedule: '20 5 * * *'
 *
 * Vernieuwt dagelijks de winkelprestatie-snapshot (klantentellers + verkopen
 * van de SRS data-export SFTP) voor het marketing-dashboard.
 * Handmatig: ?adminToken=… of x-admin-token header.
 */

import { importRetailPerformance } from '../../lib/srs-retail-import.js';
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
    const d = await importRetailPerformance();
    return res.status(200).json({
      success: true,
      window: d.window,
      winkels: d.totals?.winkels || 0,
      bezoekers: d.totals?.bezoekers || 0,
      omzet: d.totals?.omzet || 0,
      refreshedAt: d.refreshedAt
    });
  } catch (e) {
    console.error('[cron/srs-retail-import]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('srs-retail-import', handler);
