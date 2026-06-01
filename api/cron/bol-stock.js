import { trackedCron } from '../../lib/cron-auto-track.js';
import { runBolStockSync, refreshBolOfferMap, buildBolStockPlan } from '../../lib/bol-stock-sync.js';
import { runBolPriceSync } from '../../lib/bol-price-sync.js';
import { isBolConfigured } from '../../lib/bol-client.js';

export const maxDuration = 60;

/**
 * Cron: zet de bol-voorraad gelijk aan de magazijnvoorraad. Draait na de
 * voorraad-imports. Niet gekoppeld → herbereken alleen het plan (geen push).
 * ?map=1 ververst ook eerst de EAN→offerId-map (traag, 1× per dag).
 * Schedule: 0 6,12,18 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    if (!isBolConfigured()) {
      const plan = await buildBolStockPlan();
      return res.status(200).json({ success: true, configured: false, totaal: plan.totaal, metVoorraad: plan.metVoorraad });
    }
    const refreshMap = ['1', 'true', 'yes'].includes(String(req.query.map || '').toLowerCase());
    if (refreshMap) await refreshBolOfferMap();
    const out = await runBolStockSync({ dryRun: false, onlyChanged: true });

    /* Prijs-pariteit alleen als expliciet aangezet (BOL_PRICE_AUTO=1) — prijs is
       gevoelig, dus opt-in. Zet de bol-prijs gelijk aan webshop + verzendkosten. */
    let prijs = null;
    if (['1', 'true', 'yes'].includes(String(process.env.BOL_PRICE_AUTO || '').toLowerCase())) {
      try { prijs = await runBolPriceSync({ dryRun: false, onlyChanged: true }); } catch (e) { prijs = { error: e.message }; }
    }
    return res.status(200).json({ success: true, ...out, prijs });
  } catch (error) {
    console.error('[bol-stock cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-voorraadsync-cron mislukt.' });
  }
}

export default trackedCron('bol-stock', handler);
