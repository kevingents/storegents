import { trackedCron } from '../../lib/cron-auto-track.js';
import { runBolReturns } from '../../lib/bol-returns.js';

export const maxDuration = 60;

/**
 * Cron: ververs de bol-retouranalyse 1× per dag. Doet niets als bol niet
 * gekoppeld is. Schedule: 20 4 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    const r = await runBolReturns();
    return res.status(200).json({ success: true, configured: r.configured !== false, totaalRetouren: r.totaalRetouren, refreshedAt: r.refreshedAt });
  } catch (error) {
    console.error('[bol-returns cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-retour-cron mislukt.' });
  }
}

export default trackedCron('bol-returns', handler);
