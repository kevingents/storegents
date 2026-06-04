/**
 * Cron: GET /api/cron/bol-srs-sync
 *
 * Pusht nieuwe Bol-orders naar SRS. Loopt 20 minuten na /api/cron/bol-orders
 * zodat de cache vers is.
 *
 * Schedule (in vercel.json): elk uur op :20.
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { pushBolOrdersToSrs } from '../../lib/bol-srs-push.js';

export const maxDuration = 180;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const dryRun = String(req.query?.dryRun || '') === '1';
  const maxPerRun = Number(req.query?.max || process.env.BOL_SRS_MAX_PER_RUN || 50);

  try {
    const result = await pushBolOrdersToSrs({ dryRun, maxPerRun });
    return res.status(200).json(result);
  } catch (e) {
    console.error('[cron/bol-srs-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('bol-srs-sync', handler);
