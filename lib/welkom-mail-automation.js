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
import { getGoogleOpeningHoursForLocation } from './google-shopify-opening-hours.js';

const clean = (v) => String(v == null ? '' : v).trim();
const cleanEmail = (e) => {
  const s = clean(e).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
};

/* Formatteer Google opening-hours response naar nette HTML-rijen per dag.
   Input: hoursJson { monday: '10:00-18:00', ..., sunday: 'gesloten' }
   Output: <table> met 7 dagen. */
const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_NL = { monday: 'Maandag', tuesday: 'Dinsdag', wednesday: 'Woensdag', thursday: 'Donderdag', friday: 'Vrijdag', saturday: 'Zaterdag', sunday: 'Zondag' };

function renderHoursTable(hoursJson) {
  if (!hoursJson || typeof hoursJson !== 'object') return '';
  const rows = DAY_ORDER.map((d) => {
    const val = clean(hoursJson[d]) || 'Gesloten';
    return `<tr><td style="padding:3px 12px 3px 0;color:#475569;font-weight:500">${DAY_NL[d]}</td><td style="padding:3px 0;color:#0f172a;font-variant-numeric:tabular-nums">${val}</td></tr>`;
  }).join('');
  return `<table style="border-collapse:collapse;width:100%;font:400 13.5px/1.5 Inter,system-ui,sans-serif"><tbody>${rows}</tbody></table>`;
}

/* Probeer openingstijden uit Google Places te halen. Returnt HTML of null als
   er geen Place ID gemapped is of de API faalt. Caller valt dan terug op
   storeCfg.openingHours (handmatig). */
async function tryGoogleOpeningHours(storeName, storeCfg) {
  try {
    const placeId = clean(storeCfg.googlePlaceId);
    if (!placeId && !storeCfg.branchId) return null;
    const data = await getGoogleOpeningHoursForLocation({
      placeId,
      branchId: clean(storeCfg.branchId),
      store: storeName
    }, { language: 'nl', timeoutMs: 12000 });
    if (data?.hoursJson) {
      return {
        html: renderHoursTable(data.hoursJson),
        source: 'google',
        placeId: data.placeId,
        googleMapsUrl: data.googleMapsUrl || ''
      };
    }
  } catch (e) {
    console.warn(`[welkom-mail] Google opening hours fetch faalde voor ${storeName}: ${e.message}`);
  }
  return null;
}

/* Bouw de welkom-mail HTML voor 1 klant + winkel. Optionele info-blokken
   worden alleen gerenderd als de config-velden gevuld zijn. */
function buildWelkomMailHtml(customer, storeName, storeCfg, opts) {
  opts = opts || {};
  const voornaam = clean(customer.firstName || customer.voornaam || '');
  const groet = voornaam ? `Beste ${voornaam},` : 'Beste klant,';
  const shortStore = storeName.replace('GENTS ', '');

  /* Helper voor info-blokken met titel + body */
  const infoBlock = (icon, title, body) => `<div style="margin:14px 0;padding:14px 16px;background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px">
      <div style="font:600 12px Inter,system-ui,sans-serif;color:#475569;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px">${icon} ${title}</div>
      <div style="font:400 13.5px/1.6 Inter,system-ui,sans-serif;color:#0f172a">${body}</div>
    </div>`;

  const voucherBlok = storeCfg.voucherCode
    ? `<div style="margin:18px 0;padding:14px 18px;background:#fef3c7;border:1px dashed #f59e0b;border-radius:8px;text-align:center">
        <div style="font-size:12px;color:#78350f;text-transform:uppercase;letter-spacing:.06em">Welkomstcadeau</div>
        <div style="font-family:ui-monospace,monospace;font-size:24px;font-weight:700;color:#78350f;margin-top:6px;letter-spacing:.05em">${storeCfg.voucherCode}</div>
        <div style="font-size:12px;color:#78350f;margin-top:6px">Gebruik deze code bij je volgende bezoek of online bestelling.</div>
      </div>`
    : '';

  /* Openingstijden — prioriteit Google (live, mits Place ID configureerd) >
     handmatige config. Google levert per-dag table; handmatige is vrije tekst. */
  const openingBody = opts.googleHoursHtml
    ? `${opts.googleHoursHtml}${opts.googleMapsUrl ? `<div style="margin-top:8px;font-size:11.5px"><a href="${opts.googleMapsUrl}" style="color:#0B2250;text-decoration:none">Bekijk op Google Maps &rarr;</a></div>` : ''}`
    : (clean(storeCfg.openingHours)
        ? clean(storeCfg.openingHours).replace(/·/g, '<span style="color:#94a3b8">·</span>')
        : '');
  const openingBlok = openingBody ? infoBlock('&#x1F4C5;', 'Openingstijden', openingBody) : '';

  const alterationsBlok = clean(storeCfg.alterationsInfo)
    ? infoBlock('&#x2702;', 'Vermaakkosten &amp; service', storeCfg.alterationsInfo)
    : '';

  const loyaltyBlok = clean(storeCfg.loyaltyInfo)
    ? infoBlock('&#x2B50;', 'Punten sparen voor vouchers', storeCfg.loyaltyInfo)
    : '';

  const addressFooter = clean(storeCfg.addressLine)
    ? `<div style="font:400 12.5px/1.5 Inter,system-ui,sans-serif;color:#64748b;margin-top:12px"><strong style="color:#0f172a">${storeName}</strong><br>${clean(storeCfg.addressLine)}</div>`
    : '';

  const body = `
    <p style="font:400 14px/1.55 Inter,system-ui,sans-serif;color:#1e293b">Welkom in de wereld van GENTS — en bedankt voor je inschrijving in onze winkel <strong>${shortStore}</strong>.</p>
    <p style="font:400 14px/1.55 Inter,system-ui,sans-serif;color:#1e293b">Vanaf nu houden we je op de hoogte van nieuwe collecties, persoonlijke styling-tips en bijzondere evenementen — met aandacht en zonder spam.</p>
    ${voucherBlok}
    ${openingBlok}
    ${alterationsBlok}
    ${loyaltyBlok}
    <p style="font:400 14px/1.55 Inter,system-ui,sans-serif;color:#1e293b;margin-top:18px">Tot snel bij <strong>${storeName}</strong>!</p>
    <p style="font:400 13px/1.5 Inter,system-ui,sans-serif;color:#64748b;margin-top:6px">Team GENTS</p>
    ${addressFooter}`;

  return baseMailHtml({
    title: 'Welkom bij GENTS',
    intro: groet,
    bodyHtml: body,
    footer: 'Je krijgt deze mail omdat je je hebt ingeschreven in onze winkel. Wil je geen mails meer? Antwoord op deze e-mail of vraag de winkel om je uitschrijving in SRS.'
  });
}

/* Sender e-mail + display-name samenstellen.
 *   from-format: "GENTS Amsterdam <amsterdam@gents.mail.nl>"
 *   domein: gents.mail.nl (per user-spec; override via env GENTS_MAIL_DOMAIN)
 */
function buildSenderEmail(storeCfg) {
  const domain = (process.env.GENTS_MAIL_DOMAIN || 'gents.mail.nl').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const lp = clean(storeCfg.fromLocalPart || 'hallo').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  return `${lp}@${domain}`;
}

function buildSenderFromHeader(storeName, storeCfg) {
  const addr = buildSenderEmail(storeCfg);
  /* Display-name: "GENTS Amsterdam" (1:1 store naam). Headers met komma's of
     andere quote-issues vermijden door letters/cijfers/spatie/dash te behouden. */
  const safeName = String(storeName || 'GENTS').replace(/[<>"]/g, '').trim();
  return `${safeName} <${addr}>`;
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

    /* Eén Google-fetch per winkel (niet per klant) → cache voor deze run. */
    const googleHours = await tryGoogleOpeningHours(storeName, storeCfg);
    const mailOpts = googleHours
      ? { googleHoursHtml: googleHours.html, googleMapsUrl: googleHours.googleMapsUrl }
      : {};

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
        const html = buildWelkomMailHtml(c, storeName, storeCfg, mailOpts);
        const result = await sendMail({
          to: email,
          subject: clean(storeCfg.subject) || `Welkom bij ${storeName}`,
          html,
          from: buildSenderFromHeader(storeName, storeCfg),
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
