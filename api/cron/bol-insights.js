import { trackedCron } from '../../lib/cron-auto-track.js';
import { runBolInsights } from '../../lib/bol-insights.js';
import { isBolConfigured } from '../../lib/bol-client.js';

export const maxDuration = 300;

/**
 * Cron: ververs bol omzet/best-sellers/buy-box/performance 1× per dag (na de
 * insights-update van bol om 5u). Niet gekoppeld → no-op. Schedule: 30 6 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    if (!isBolConfigured()) return res.status(200).json({ success: true, configured: false });
    const r = await runBolInsights();
    return res.status(200).json({ success: true, omzet: r.omzet, stuks: r.stuks, buyboxVerliezers: (r.buyboxVerliezers || []).length, refreshedAt: r.refreshedAt });
  } catch (error) {
    console.error('[bol-insights cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-insights-cron mislukt.' });
  }
}

export default trackedCron('bol-insights', handler);
