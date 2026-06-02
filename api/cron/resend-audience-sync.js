/**
 * Cron: GET /api/cron/resend-audience-sync
 * Schedule: '55 5 * * *'
 *
 * Synct opt-in GENTS-klanten naar Resend Audiences (met segmentatie per winkel)
 * — maar ALLEEN als de sync is aangezet (config.enabled). Anders no-op.
 * Handmatig: ?adminToken=… of x-admin-token header.
 */

import { getResendAudienceConfig, runResendAudienceSync } from '../../lib/resend-audience.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

export const maxDuration = 300;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const cfg = await getResendAudienceConfig();
    if (!cfg.enabled) {
      return res.status(200).json({ success: true, skipped: true, reason: 'Resend audience-sync staat uit' });
    }
    /* ?inc=1 → goedkope incrementele run (alleen recent gewijzigde klanten);
       near-realtime elke 2 uur. Zonder vlag de bredere dagelijkse run. */
    const incremental = ['1', 'true', 'yes'].includes(String(req.query?.inc || '').toLowerCase());
    const result = await runResendAudienceSync({ dryRun: false, incremental, sinceHours: incremental ? 3 : undefined });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('[cron/resend-audience-sync]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('resend-audience-sync', handler);
