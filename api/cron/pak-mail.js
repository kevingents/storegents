import { runPakMailAutomation } from '../../lib/pak-mail-automation.js';

/* Daily cron @ :45 — pak-mail aan klanten die 7 dagen geleden een pak kochten.
   Idempotent via 180-dagen cooldown in pak-mail-sent.json. */
export const maxDuration = 300;

export default async function handler(req, res) {
  try {
    const out = await runPakMailAutomation({ dryRun: false });
    return res.status(200).json({ success: true, ...out, ts: new Date().toISOString() });
  } catch (e) {
    console.error('[cron/pak-mail]', e);
    return res.status(500).json({ success: false, message: e.message });
  }
}
