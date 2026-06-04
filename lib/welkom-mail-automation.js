/**
 * lib/welkom-mail-automation.js
 *
 * Welkom-mail flow voor nieuwe SRS-inschrijvingen per winkel.
 *
 * Pipeline:
 *   1. Voor elke ENABLED winkel in config:
 *      a) Vraag SRS om klanten registered_in=branchId, updated >= lookback
 *      b) Filter: valid email, allowMailings=true, niet al gemaild (idempotency)
 *      c) Per klant: bouw mail (template + persoonlijke groet) + verstuur via Resend
 *      d) Markeer in sent-blob met messageId
 *   2. Returnt { sent: N, skipped: M, errors: [] }
 *
 * Veilig: alleen klanten met AllowMailings + emailadres met @ + niet eerder gemaild.
 */

import { getCustomers } from './srs-customers-client.js';
import { branchIdToStoreName } from './business-config.js';
import { sendMail, baseMailHtml } from './gents-mailer.js';
import {
  getWelkomMailConfig,
  hasReceivedWelkomMail,
  markWelkomMailSent
} from './welkom-mail-store.js';

const clean = (v) => String(v == null ? '' : v).trim();
const cleanEmail = (e) => {
  const s = clean(e).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
};

/* Bouw de welkom-mail HTML voor 1 klant + winkel. Templates zijn nog
   eenvoudig — admin kan ze later via UI personaliseren per winkel. */
function buildWelkomMailHtml(customer, storeName, storeCfg) {
  const voornaam = clean(customer.firstName || customer.voornaam || '');
  const groet = voornaam ? `Beste ${voornaam},` : 'Beste klant,';
  const voucherBlok = storeCfg.voucherCode
    ? `<div style="margin:18px 0;padding:14px 18px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:8px;text-align:center">
        <div style="font-size:12px;color:#78350f;text-transform:uppercase;letter-spacing:.06em">Welkomstcadeau</div>
        <div style="font-family:ui-monospace,monospace;font-size:24px;font-weight:700;color:#78350f;margin-top:6px;letter-spacing:.05em">${storeCfg.voucherCode}</div>
        <div style="font-size:12px;color:#78350f;margin-top:6px">Gebruik deze code bij je volgende bezoek of online bestelling.</div>
      </div>`
    : '';
  const intro = `<p style="font:400 14px/1.55 Inter,system-ui,sans-serif;color:#1e293b">Welkom in de wereld van GENTS — en bedankt voor je inschrijving in onze winkel <strong>${storeName.replace('GENTS ', '')}</strong>.</p>
    <p style="font:400 14px/1.55 Inter,system-ui,sans-serif;color:#1e293b">Vanaf nu houden we je op de hoogte van nieuwe collecties, persoonlijke styling-tips en bijzondere evenementen — met aandacht en zonder spam.</p>
    ${voucherBlok}
    <p style="font:400 14px/1.55 Inter,system-ui,sans-serif;color:#1e293b">Tot snel bij <strong>${storeName}</strong>!</p>
    <p style="font:400 13px/1.5 Inter,system-ui,sans-serif;color:#64748b;margin-top:18px">Team GENTS</p>`;
  return baseMailHtml({
    title: 'Welkom bij GENTS',
    intro: groet,
    bodyHtml: intro,
    footer: 'Je krijgt deze mail omdat je je hebt ingeschreven in onze winkel. Wil je geen mails meer? Antwoord op deze e-mail of vraag de winkel om je uitschrijving in SRS.'
  });
}

/* Sender e-mail samenstellen uit per-winkel localPart + GENTS domein. */
function buildSenderEmail(storeCfg) {
  const domain = (process.env.GENTS_MAIL_DOMAIN || 'mail.gents.nl').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const lp = clean(storeCfg.fromLocalPart || 'hallo').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `${lp}@${domain}`;
}

/**
 * Hoofd-flow. Loopt alle enabled winkels in config af.
 *
 * @param {Object} opts
 * @param {boolean} [opts.dryRun=false] — geen mails versturen, alleen rapporteren
 * @param {number}  [opts.maxPerRun] — override config-max
 * @param {string}  [opts.onlyStore] — beperken tot 1 winkel (test)
 */
export async function runWelkomMailAutomation({ dryRun = false, maxPerRun, onlyStore = '' } = {}) {
  const cfg = await getWelkomMailConfig();
  const cap = Math.max(1, Number(maxPerRun || cfg.maxPerRun || 50));
  const lookback = Math.max(1, Number(cfg.lookbackHours || 24));
  const updatedFrom = new Date(Date.now() - lookback * 3600000).toISOString().slice(0, 19);

  const stores = Object.entries(cfg.stores || {})
    .filter(([name, sc]) => sc?.enabled === true)
    .filter(([name]) => !onlyStore || name === onlyStore);

  if (!stores.length) {
    return { success: true, processed: 0, sent: 0, skipped: 0, byStore: {}, message: 'Geen winkels enabled in welkom-mail-config.' };
  }

  let totalSent = 0, totalSkippedAlready = 0, totalSkippedNoMail = 0, totalSkippedNoOptIn = 0, totalErrors = 0;
  const byStore = {};
  const samples = [];

  outer: for (const [storeName, storeCfg] of stores) {
    const branchId = clean(storeCfg.branchId);
    if (!branchId) { byStore[storeName] = { skipped: 'no branchId in config' }; continue; }

    /* Klanten ophalen die in deze winkel zijn ingeschreven binnen lookback. */
    let customers = [];
    try {
      customers = await getCustomers({
        updatedFrom,
        registeredInBranchId: branchId,
        allowMailings: true
      });
    } catch (e) {
      byStore[storeName] = { error: `SRS-fetch: ${e.message}` };
      totalErrors += 1;
      continue;
    }

    let storeSent = 0, storeSkippedAlready = 0, storeSkippedNoMail = 0, storeErr = 0;
    for (const c of (customers || [])) {
      if (totalSent >= cap) break outer;
      const email = cleanEmail(c.email);
      if (!email) { storeSkippedNoMail += 1; totalSkippedNoMail += 1; continue; }
      const opt = clean(c.allowMailings) === 'true' || c.allowMailings === true;
      if (!opt) { totalSkippedNoOptIn += 1; continue; }
      if (await hasReceivedWelkomMail(email)) { storeSkippedAlready += 1; totalSkippedAlready += 1; continue; }

      if (dryRun) {
        samples.push({ email, store: storeName, voornaam: clean(c.firstName), branchId });
        storeSent += 1; totalSent += 1;
        continue;
      }

      try {
        const html = buildWelkomMailHtml(c, storeName, storeCfg);
        const from = buildSenderEmail(storeCfg);
        const result = await sendMail({
          to: email,
          subject: clean(storeCfg.subject) || `Welkom bij ${storeName}`,
          html,
          from: `GENTS ${storeName.replace('GENTS ', '')} <${from}>`,
          headers: { 'X-Welkom-Mail': 'gents-welkom-v1', 'X-Welkom-Store': storeName }
        });
        await markWelkomMailSent(email, {
          store: storeName,
          branchId,
          messageId: result?.id || result?.messageId || ''
        });
        storeSent += 1; totalSent += 1;
        if (samples.length < 10) samples.push({ email, store: storeName, messageId: result?.id || '' });
      } catch (e) {
        storeErr += 1; totalErrors += 1;
        if (samples.length < 10) samples.push({ email, store: storeName, error: e.message });
      }
    }

    byStore[storeName] = {
      sent: storeSent,
      skippedAlready: storeSkippedAlready,
      skippedNoMail: storeSkippedNoMail,
      errors: storeErr,
      branchId
    };
  }

  return {
    success: true,
    dryRun,
    lookbackHours: lookback,
    updatedFrom,
    processed: totalSent + totalSkippedAlready + totalSkippedNoMail + totalSkippedNoOptIn,
    sent: totalSent,
    skippedAlready: totalSkippedAlready,
    skippedNoMail: totalSkippedNoMail,
    skippedNoOptIn: totalSkippedNoOptIn,
    errors: totalErrors,
    byStore,
    samples
  };
}
