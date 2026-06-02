/**
 * Cron: GET /api/cron/automations?id=<automation>
 *
 * Draait één registry-automation (verjaardag/win-back/replenishment). Alleen als
 * die automation enabled is. Per run een batch (maxPerRun); opeenvolgende dagen
 * werken de basis af. Per-winkel afzender via Resend.
 */

import { getAutomationConfig, runAutomation } from '../../lib/automation-runner.js';
import { AUTOMATIONS } from '../../lib/automations-registry.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

export const maxDuration = 300;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const id = String(req.query?.id || '').trim();
  if (!AUTOMATIONS[id]) return res.status(400).json({ success: false, message: 'Onbekende automation.' });

  try {
    const cfg = await getAutomationConfig(id);
    if (!cfg.enabled) return res.status(200).json({ success: true, skipped: true, reason: `${id} staat uit` });
    const result = await runAutomation(id, { dryRun: false });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error(`[cron/automations:${id}]`, e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

export default trackedCron('automations', handler);
