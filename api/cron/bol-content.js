import { trackedCron } from '../../lib/cron-auto-track.js';
import { buildBolContentPlan } from '../../lib/bol-content-optimizer.js';
import { runBolContentAuto, ensureBolFamilies } from '../../lib/bol-content-writer.js';
import { isBolConfigured } from '../../lib/bol-client.js';

export const maxDuration = 60;

/**
 * Cron: herbereken het bol content-plan én push autonoom de geoptimaliseerde
 * content voor alle push-klare producten (alleen wat wijzigde). Draait na de
 * products-refresh. Kill-switch: BOL_AUTO_CONTENT='0' → alleen plan, geen push.
 * Schedule: 25 4 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    const plan = await buildBolContentPlan();
    const configured = isBolConfigured();

    /* Families aanvullen waar ze ontbreken (los van de content-kill-switch —
       jullie willen families aanmaken; overschrijft bestaande niet).
       Uitzetten met BOL_FAMILIES_AUTO=0. */
    let families = null;
    const familiesOff = ['0', 'false', 'no'].includes(String(process.env.BOL_FAMILIES_AUTO || '').toLowerCase());
    if (configured && !familiesOff) {
      try { families = await ensureBolFamilies({ dryRun: false, maxCheck: Number(process.env.BOL_FAMILIES_MAX || 120) }); } catch (e) { families = { error: e.message }; }
    }

    /* Volledige content-push alleen als expliciet aangezet (BOL_AUTO_CONTENT≠0). */
    const autoOff = ['0', 'false', 'no'].includes(String(process.env.BOL_AUTO_CONTENT || '').toLowerCase());
    if (autoOff || !configured) {
      return res.status(200).json({ success: true, totaal: plan.coverage?.totaal || 0, gepusht: 0, autonoom: false, configured, families, refreshedAt: plan.refreshedAt });
    }
    const maxPush = Number(process.env.BOL_AUTO_CONTENT_MAX || 300);
    const out = await runBolContentAuto({ dryRun: false, maxPush });
    return res.status(200).json({ success: true, totaal: plan.coverage?.totaal || 0, autonoom: true, families, ...out, refreshedAt: plan.refreshedAt });
  } catch (error) {
    console.error('[bol-content cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-content-cron mislukt.' });
  }
}

export default trackedCron('bol-content', handler);
