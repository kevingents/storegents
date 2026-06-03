/**
 * Cron: GET /api/cron/automations?id=<automation>
 *
 * Draait één registry-automation (verjaardag/win-back/replenishment). Alleen als
 * die automation enabled is. Per run een batch (maxPerRun); opeenvolgende dagen
 * werken de basis af. Per-winkel afzender via Resend.
 */

import { getAutomationConfig, runAutomation, runEnabledCustom } from '../../lib/automation-runner.js';
import { AUTOMATIONS } from '../../lib/automations-registry.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

export const maxDuration = 300;

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const id = String(req.query?.id || '').trim();

  try {
    /* Alle ingeschakelde custom-automations in één run. */
    if (id === 'custom') {
      const results = await runEnabledCustom({ dryRun: false });
      return res.status(200).json({ success: true, ran: results.length, results });
    }
    if (!AUTOMATIONS[id]) return res.status(400).json({ success: false, message: 'Onbekende automation.' });
    const cfg = await getAutomationConfig(id);
    if (!cfg.enabled) return res.status(200).json({ success: true, skipped: true, reason: `${id} staat uit` });
    const result = await runAutomation(id, { dryRun: false });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error(`[cron/automations:${id}]`, e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}

/* 4 schedules (birthday/winback/replenishment/custom) gebruikten dezelfde
   tracked-key 'automations' → cron-overzicht kon niet zien welke gefaald was.
   Dispatch maakt per request een aparte trackedCron met key 'automations:${id}'
   zodat elke automation zijn eigen geschiedenis krijgt in het overzicht. */
async function dispatch(req, res) {
  const id = String(req.query?.id || 'unknown').trim() || 'unknown';
  return trackedCron(`automations:${id}`, handler)(req, res);
}

export default dispatch;
