import { trackedCron } from '../../lib/cron-auto-track.js';
import { runBolStockSync, refreshBolOfferMap, buildBolStockPlan } from '../../lib/bol-stock-sync.js';
import { runBolPriceSync } from '../../lib/bol-price-sync.js';
import { isBolConfigured } from '../../lib/bol-client.js';

export const maxDuration = 60;

/**
 * Cron: zet de bol-voorraad gelijk aan de magazijnvoorraad. Schrijven naar bol
 * is OPT-IN: alleen als BOL_STOCK_AUTO=1. Zonder die vlag wordt enkel het plan
 * herberekend (geen push). ?map=1 ververst ook de EAN→offerId-map.
 * Prijs-pariteit apart opt-in via BOL_PRICE_AUTO=1. Schedule: 0 6,12,18 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  const on = (v) => ['1', 'true', 'yes'].includes(String(v || '').toLowerCase());
  try {
    if (!isBolConfigured() || !on(process.env.BOL_STOCK_AUTO)) {
      const plan = await buildBolStockPlan();
      return res.status(200).json({ success: true, configured: isBolConfigured(), autonoom: false, totaal: plan.totaal, metVoorraad: plan.metVoorraad });
    }
    const refreshMap = ['1', 'true', 'yes'].includes(String(req.query.map || '').toLowerCase());
    if (refreshMap) await refreshBolOfferMap();
    const out = await runBolStockSync({ dryRun: false, onlyChanged: true });

    /* Prijs-pariteit alleen als expliciet aangezet (BOL_PRICE_AUTO=1) — prijs is
       gevoelig, dus opt-in. Zet de bol-prijs gelijk aan webshop + verzendkosten. */
    let prijs = null;
    if (on(process.env.BOL_PRICE_AUTO)) {
      try { prijs = await runBolPriceSync({ dryRun: false, onlyChanged: true }); } catch (e) { prijs = { error: e.message }; }
    }
    return res.status(200).json({ success: true, ...out, prijs });
  } catch (error) {
    console.error('[bol-stock cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-voorraadsync-cron mislukt.' });
  }
}

export default trackedCron('bol-stock', handler);
