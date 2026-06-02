/**
 * Cron: GET /api/cron/automation-new-collection
 * Schedule: '20 9 * * *'
 *
 * Slimme automation "nieuwe collectie → eerdere kopers met maat op voorraad".
 * Draait alleen als enabled. Per run een batch klanten (maxPerRun); opeenvolgende
 * dagen werken de hele basis af per collectie-drop. Per-winkel afzender via Resend.
 */

import { getNcConfig, runNewCollection } from '../../lib/automation-new-collection.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

export const maxDuration = 300;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const cfg = await getNcConfig();
    if (!cfg.enabled) {
      return res.status(200).json({ success: true, skipped: true, reason: 'automation staat uit' });
    }
    const result = await runNewCollection({ dryRun: false });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('[cron/automation-new-collection]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('automation-new-collection', handler);
