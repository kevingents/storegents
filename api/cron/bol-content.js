import { trackedCron } from '../../lib/cron-auto-track.js';
import { buildBolContentPlan } from '../../lib/bol-content-optimizer.js';
import { runBolContentAuto, ensureBolFamilies } from '../../lib/bol-content-writer.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { getBolSettings } from '../../lib/bol-settings-store.js';

export const maxDuration = 300;

/**
 * Cron: herbereken het bol content-plan. Schrijven naar bol is OPT-IN:
 *   BOL_AUTO_CONTENT=1  → push geoptimaliseerde content (alleen wat wijzigde)
 *   BOL_FAMILIES_AUTO=1 → vul ontbrekende productfamilies aan (overschrijft niet)
 * Zonder die vlaggen wordt er NIETS naar bol geschreven (alleen het plan
 * herberekend). Schedule: 25 4 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    const plan = await buildBolContentPlan();
    const configured = isBolConfigured();
    const settings = await getBolSettings();

    /* Families aanvullen — alleen als ingeschakeld (Instellingen). */
    let families = null;
    if (configured && settings.familiesAuto) {
      try { families = await ensureBolFamilies({ dryRun: false, maxCheck: Number(process.env.BOL_FAMILIES_MAX || 80), items: plan.items }); } catch (e) { families = { error: e.message }; }
    }

    /* Volledige content-push — alleen als ingeschakeld (Instellingen). */
    if (!settings.contentAuto || !configured) {
      return res.status(200).json({ success: true, totaal: plan.coverage?.totaal || 0, gepusht: 0, autonoom: false, configured, families, refreshedAt: plan.refreshedAt });
    }
    const maxPush = Number(process.env.BOL_AUTO_CONTENT_MAX || 300);
    const out = await runBolContentAuto({ dryRun: false, maxPush, items: plan.items });
    return res.status(200).json({ success: true, totaal: plan.coverage?.totaal || 0, autonoom: true, families, ...out, refreshedAt: plan.refreshedAt });
  } catch (error) {
    console.error('[bol-content cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-content-cron mislukt.' });
  }
}

export default trackedCron('bol-content', handler);
