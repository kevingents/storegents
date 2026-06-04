import { trackedCron } from '../../lib/cron-auto-track.js';
import { runBolStockSync, refreshBolOfferMap, buildBolStockPlan } from '../../lib/bol-stock-sync.js';
import { runBolPriceSync } from '../../lib/bol-price-sync.js';
import { isBolConfigured } from '../../lib/bol-client.js';
import { getBolSettings } from '../../lib/bol-settings-store.js';
import { readBolStockFailures } from '../../lib/bol-stock-failures-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

export const maxDuration = 300;

/**
 * Cron: zet de bol-voorraad gelijk aan de magazijnvoorraad − veiligheidsmarge.
 * Voorraad-sync staat standaard AAN (altijd veilig: bol toont nooit meer dan je
 * magazijn). Uitzetten met BOL_STOCK_AUTO=0. ?map=1 ververst de offer-map.
 * Prijs-pariteit apart opt-in via BOL_PRICE_AUTO=1. Schedule: 0 6,12,18 * * *.
 */
async function handler(req, res) {
  const secret = String(process.env.BOL_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '').replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    const settings = await getBolSettings();
    if (!isBolConfigured() || !settings.stockAuto) {
      const plan = await buildBolStockPlan();
      return res.status(200).json({ success: true, configured: isBolConfigured(), autonoom: false, totaal: plan.totaal, metVoorraad: plan.metVoorraad });
    }
    const refreshMap = ['1', 'true', 'yes'].includes(String(req.query.map || '').toLowerCase());
    if (refreshMap) await refreshBolOfferMap();
    const out = await runBolStockSync({ dryRun: false, onlyChanged: true });

    /* Mail bij sanity-abort OF EAN-fouten. Hergebruikt BOL_SRS_NOTIFY_EMAILS
       env zodat 1 lijst alle bol-failures bewaakt. */
    const shouldMail = out?.aborted || (Number(out?.fouten) > 0);
    if (shouldMail) {
      try {
        const to = String(process.env.BOL_SRS_NOTIFY_EMAILS || process.env.BOL_STOCK_NOTIFY_EMAILS || process.env.MAINTAINER_EMAIL || '')
          .split(',').map((s) => s.trim()).filter(Boolean);
        if (to.length) {
          const allFailures = await readBolStockFailures();
          let subject, intro, bodyHtml;
          if (out.aborted) {
            subject = `[GENTS] Bol-voorraadsync ABORTED — veiligheidsguard`;
            intro = `De cron heeft de sync afgebroken (anders zou bol-voorraad foutief leeg gezet worden). Reden:`;
            bodyHtml = `<div style="padding:14px;background:#fef2f2;color:#7f1d1d;border-radius:8px;font-family:monospace;font-size:13px">${out.reason || 'onbekend'}</div>
              <p style="margin-top:12px;font-size:13px">Check SRS-voorraadimport + magazijn-config in business-config.</p>`;
          } else {
            subject = `[GENTS] Bol-voorraadsync: ${out.fouten} EAN(s) faalden bij push`;
            intro = `Sync draaide door (${out.gepusht} succesvol), maar ${out.fouten} EAN(s) faalden bij de bol-API. Totaal openstaande failures: ${Object.keys(allFailures.failed || {}).length}.`;
            const top = (out.resultaten || []).filter((r) => r.error).slice(0, 20);
            bodyHtml = `<table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="background:#f1f5f9"><th style="padding:6px 8px;text-align:left">EAN</th><th style="padding:6px 8px;text-align:left">Offer-ID</th><th style="padding:6px 8px;text-align:left">Error</th></tr></thead>
              <tbody>${top.map((r) => `<tr><td style="padding:6px 8px;font-family:monospace">${r.ean}</td><td style="padding:6px 8px;font-family:monospace">${r.offerId}</td><td style="padding:6px 8px;color:#7f1d1d">${String(r.error || '').slice(0, 300)}</td></tr>`).join('')}</tbody></table>`;
          }
          await sendMail({ to, subject, html: baseMailHtml({ title: subject.replace('[GENTS] ', ''), intro, bodyHtml, footer: 'Verstuurd door /api/cron/bol-stock' }) });
        }
      } catch (mailErr) { console.warn('[bol-stock cron mail]', mailErr.message); }
    }

    /* Prijs-pariteit alleen als ingeschakeld (Instellingen) — prijs is gevoelig.
       Zet de bol-prijs gelijk aan webshop + verzendkosten. */
    let prijs = null;
    if (settings.priceAuto) {
      try { prijs = await runBolPriceSync({ dryRun: false, onlyChanged: true }); } catch (e) { prijs = { error: e.message }; }
    }
    return res.status(200).json({ success: true, ...out, prijs });
  } catch (error) {
    console.error('[bol-stock cron]', error);
    return res.status(500).json({ success: false, message: error.message || 'bol-voorraadsync-cron mislukt.' });
  }
}

export default trackedCron('bol-stock', handler);
