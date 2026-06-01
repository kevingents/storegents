import { trackedCron } from '../../lib/cron-auto-track.js';
import { runBolOrders } from '../../lib/bol-orders.js';
import { isBolConfigured } from '../../lib/bol-client.js';

export const maxDuration = 300;

/**
 * Cron: ververs de openstaande bol-orders (verzendbevestiging-bewaking) een paar
 * keer per dag, want orders zijn tijdgevoelig. Niet gekoppeld → no-op.
 * Schedule: 0 7,11,15,19 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    if (!isBolConfigured()) return res.status(200).json({ success: true, configured: false });
    const r = await runBolOrders();
    return res.status(200).json({ success: true, totaalOpen: r.totaalOpen, teLaat: r.teLaat, vandaag: r.vandaag, refreshedAt: r.refreshedAt });
  } catch (error) {
    console.error('[bol-orders cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-orders-cron mislukt.' });
  }
}

export default trackedCron('bol-orders', handler);
