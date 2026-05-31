import { trackedCron } from '../../lib/cron-auto-track.js';
import { buildBolContentPlan } from '../../lib/bol-content-optimizer.js';

export const maxDuration = 60;

/**
 * Cron: herbereken het bol content-optimalisatieplan 1× per dag uit de
 * Shopify-cache (na de products-refresh). Schrijft niets naar bol — read-only.
 * Schedule: 25 4 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    const r = await buildBolContentPlan();
    return res.status(200).json({ success: true, totaal: r.coverage?.totaal || 0, refreshedAt: r.refreshedAt });
  } catch (error) {
    console.error('[bol-content cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-content-cron mislukt.' });
  }
}

export default trackedCron('bol-content', handler);
