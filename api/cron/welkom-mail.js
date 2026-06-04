/**
 * Cron: GET /api/cron/welkom-mail
 *
 * Draait de welkom-mail automation voor alle enabled winkels (default in test:
 * alleen GENTS Amsterdam). Schedule: elk uur op :15.
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';
import { runWelkomMailAutomation } from '../../lib/welkom-mail-automation.js';

export const maxDuration = 300;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    const out = await runWelkomMailAutomation({ dryRun: false });
    return res.status(200).json(out);
  } catch (e) {
    console.error('[cron/welkom-mail]', e);
    return res.status(500).json({ success: false, message: e.message || 'Cron mislukt.' });
  }
}

export default trackedCron('welkom-mail', handler);
