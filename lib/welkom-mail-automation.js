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

/* Brand-kleuren (Spotler-stijl): donker navy + off-white achtergronden + zwart
   hoofdblok. Verdana als web-safe e-mail font (consistent met Spotler-template). */
const BRAND = {
  text: '#0A1F33',         /* hoofdtekst */
  bgPage: '#F2F2F2',       /* outer mail-client background */
  bgSection: '#F5F5F2',    /* off-white content card */
  bgHeader: '#000000',     /* zwart logo-blok */
  bgMenu: '#F5F5F2',       /* off-white categorieënrij */
  bgWhite: '#FFFFFF',
  ctaBg: '#0A1F33',        /* dark-navy knop */
  ctaText: '#FFFFFF',
  muted: '#475569',
  font: 'Verdana, Geneva, sans-serif'
};

/* Formatteer Google opening-hours response naar nette HTML-rijen per dag.
   Output gebruikt Verdana/brand-kleuren (mail-safe). */
const DAY_ORDER = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const DAY_NL = { monday: 'Maandag', tuesday: 'Dinsdag', wednesday: 'Woensdag', thursday: 'Donderdag', friday: 'Vrijdag', saturday: 'Zaterdag', sunday: 'Zondag' };

function renderHoursTable(hoursJson) {
  if (!hoursJson || typeof hoursJson !== 'object') return '';
  const rows = DAY_ORDER.map((d) => {
    const val = clean(hoursJson[d]) || 'Gesloten';
    return `<tr><td style="padding:3px 14px 3px 0;color:${BRAND.muted};font:400 13px/1.5 ${BRAND.font}">${DAY_NL[d]}</td><td style="padding:3px 0;color:${BRAND.text};font:400 13px/1.5 ${BRAND.font}">${val}</td></tr>`;
  }).join('');
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>`;
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

/* Helper: render een info-blok (Spotler-stijl) met titel + body in het content-
   card. Padding/kleuren match het MailPlus design van de chino-test. */
function infoBlock(title, bodyHtml) {
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="margin-top:18px"><tbody><tr>
    <td bgcolor="${BRAND.bgWhite}" style="background-color:${BRAND.bgWhite};padding:18px 22px;border:1px solid #E5E7EB">
      <div style="color:${BRAND.text};font:700 13px/1.4 ${BRAND.font};text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">${title}</div>
      <div style="color:${BRAND.text};font:400 14px/1.6 ${BRAND.font}">${bodyHtml}</div>
    </td></tr></tbody></table>`;
}

/* Exports voor preview/test-mail vanuit admin endpoint. */
export { buildWelkomMailHtml, buildSenderFromHeader, tryGoogleOpeningHours };

/* Bouw de welkom-mail HTML in Spotler/MailPlus stijl (zie chino-test referentie).
   Layout: 600px container · zwart header met logo · menu-rij · optionele hero ·
   off-white content-card met "Hey {voornaam}," + intro + info-blokken + CTA ·
   signature-footer. Volledig table-based voor mail-client compatibility. */
function buildWelkomMailHtml(customer, storeName, storeCfg, opts) {
  opts = opts || {};
  const voornaam = clean(customer.firstName || customer.voornaam || '');
  const groet = voornaam ? `Hey ${voornaam},` : 'Hey,';

  /* — Header: zwart blok met GENTS-tekst (of logo als logoUrl is gevuld). */
  const logoUrl = clean(storeCfg.logoUrl);
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="GENTS" width="180" style="display:inline-block;max-width:180px;height:auto;border:0">`
    : `<div style="color:#FFFFFF;font:700 28px/1.1 ${BRAND.font};letter-spacing:6px">GENTS</div>`;
  const headerBlock = `<table bgcolor="${BRAND.bgHeader}" cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="background-color:${BRAND.bgHeader}"><tbody><tr>
    <td align="center" style="padding:22px 15px">
      <a href="${clean(storeCfg.ctaUrl) || 'https://gents.nl'}" style="text-decoration:none;color:#FFFFFF">${logoHtml}</a>
    </td></tr></tbody></table>`;

  /* — Menu-rij: 4 categorieën als knoppen met links naar gents.nl. */
  const menuCol = (label, href) => `<td align="center" bgcolor="${BRAND.bgMenu}" style="background-color:${BRAND.bgMenu};padding:14px 6px;width:25%">
    <a href="${href}" style="color:${BRAND.text};font:600 13px/1.2 ${BRAND.font};text-decoration:none;text-transform:uppercase;letter-spacing:1px">${label}</a>
  </td>`;
  const menuBlock = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="border-collapse:collapse"><tbody><tr>
    ${menuCol('Pakken', 'https://gents.nl/collections/pakken')}
    ${menuCol('Overhemden', 'https://gents.nl/collections/overhemden')}
    ${menuCol('Colberts', 'https://gents.nl/collections/colberts')}
    ${menuCol('Smokings', 'https://gents.nl/collections/smokings')}
  </tr></tbody></table>`;

  /* — Hero-afbeelding (optioneel). Klik = ctaUrl of heroImageLink. */
  const heroUrl = clean(storeCfg.heroImageUrl);
  const heroLink = clean(storeCfg.heroImageLink) || clean(storeCfg.ctaUrl) || 'https://gents.nl';
  const heroBlock = heroUrl
    ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tbody><tr><td align="center" bgcolor="${BRAND.bgWhite}" style="background-color:${BRAND.bgWhite}">
        <a href="${heroLink}" style="display:block;text-decoration:none"><img src="${heroUrl}" alt="Welkom bij GENTS" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a>
      </td></tr></tbody></table>`
    : '';

  /* — Voucher-blok (optioneel): donker navy badge met code. */
  const voucherBlock = clean(storeCfg.voucherCode)
    ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="margin-top:18px"><tbody><tr>
        <td align="center" bgcolor="${BRAND.text}" style="background-color:${BRAND.text};padding:20px 24px">
          <div style="color:#FFFFFF;font:600 11px/1 ${BRAND.font};letter-spacing:2px;text-transform:uppercase">Welkomstcadeau</div>
          <div style="color:#FFFFFF;font:700 28px/1.1 ${BRAND.font};letter-spacing:3px;margin-top:10px">${clean(storeCfg.voucherCode)}</div>
          <div style="color:#D1D5DB;font:400 12px/1.4 ${BRAND.font};margin-top:8px">Gebruik bij je volgende bezoek of online bestelling.</div>
        </td></tr></tbody></table>`
    : '';

  /* — Openingstijden: Google live > handmatig fallback. */
  const openingBody = opts.googleHoursHtml
    ? `${opts.googleHoursHtml}${opts.googleMapsUrl ? `<div style="margin-top:10px"><a href="${opts.googleMapsUrl}" style="color:${BRAND.text};font:600 12px/1 ${BRAND.font};text-decoration:underline">Bekijk op Google Maps</a></div>` : ''}`
    : (clean(storeCfg.openingHours) ? clean(storeCfg.openingHours) : '');
  const openingBlok = openingBody ? infoBlock('Openingstijden', openingBody) : '';
  const alterationsBlok = clean(storeCfg.alterationsInfo) ? infoBlock('Vermaakkosten &amp; service', clean(storeCfg.alterationsInfo)) : '';
  const loyaltyBlok = clean(storeCfg.loyaltyInfo) ? infoBlock('Punten sparen voor vouchers', clean(storeCfg.loyaltyInfo)) : '';

  /* — CTA-knop in dark-navy. */
  const ctaUrl = clean(storeCfg.ctaUrl) || 'https://gents.nl';
  const ctaLabel = clean(storeCfg.ctaLabel) || 'BEZOEK ONZE WEBSHOP';
  const ctaBlock = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="margin-top:24px"><tbody><tr>
    <td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:10px 25px 30px">
      <table border="0" cellspacing="0" cellpadding="0" role="presentation" align="center" style="display:inline-table"><tbody><tr>
        <td align="center" bgcolor="${BRAND.ctaBg}" style="background-color:${BRAND.ctaBg};border-radius:7px;padding:14px 32px">
          <a href="${ctaUrl}" style="color:${BRAND.ctaText};font:700 14px/1.2 ${BRAND.font};letter-spacing:1.5px;text-decoration:none">${ctaLabel}</a>
        </td></tr></tbody></table>
    </td></tr></tbody></table>`;

  /* — Content-card: "Hey {voornaam}," + intro tekst + info-blokken. */
  const shortStore = storeName.replace(/^GENTS\s+/i, '');
  const introBody = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tbody>
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:40px 20px 16px">
      <h1 style="color:${BRAND.text};font:700 22px/1.25 ${BRAND.font};margin:0">${groet}</h1>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:8px 25px 4px">
      <p style="color:${BRAND.text};font:400 14px/1.6 ${BRAND.font};margin:0">Welkom bij <strong>GENTS ${shortStore}</strong>. Fijn dat je je bij ons hebt ingeschreven — vanaf nu houden we je op de hoogte van nieuwe collecties, styling-tips en bijzondere events bij ons in de winkel.</p>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:14px 25px 4px">
      <p style="color:${BRAND.text};font:400 14px/1.6 ${BRAND.font};margin:0">Hieronder vind je een paar dingen die handig zijn om te weten over onze winkel.</p>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:0 25px">
      ${openingBlok}
      ${alterationsBlok}
      ${loyaltyBlok}
      ${voucherBlock}
    </td></tr>
  </tbody></table>`;

  /* — Signature footer (persoonlijke afsluiting). */
  const sigName = clean(storeCfg.signatureName);
  const sigRole = clean(storeCfg.signatureRole);
  const sigPhone = clean(storeCfg.signaturePhone);
  const sigMobile = clean(storeCfg.signatureMobile);
  const sigEmail = clean(storeCfg.senderEmail);
  const sigAddress = clean(storeCfg.addressLine);
  const sigContact = [
    sigPhone && `<strong>T:</strong> ${sigPhone}`,
    sigMobile && `<strong>M:</strong> ${sigMobile}`,
    sigEmail && `<strong>E:</strong> ${sigEmail}`,
    sigAddress && `<strong>A:</strong> ${sigAddress}`
  ].filter(Boolean).join('<br>');
  const sigBlock = sigName
    ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="margin-top:0"><tbody><tr>
        <td bgcolor="${BRAND.bgWhite}" style="background-color:${BRAND.bgWhite};padding:28px 25px;border-top:1px solid #E5E7EB">
          <p style="color:${BRAND.text};font:400 13px/1.5 ${BRAND.font};margin:0">Met vriendelijke groet,</p>
          <p style="color:${BRAND.text};font:700 16px/1.3 ${BRAND.font};margin:14px 0 0">${sigName}</p>
          ${sigRole ? `<p style="color:${BRAND.text};font:400 13px/1.4 ${BRAND.font};margin:2px 0 0">${sigRole} | <a href="https://gents.nl" style="color:${BRAND.text};text-decoration:none"><strong>www.gents.nl</strong></a></p>` : ''}
          ${sigContact ? `<p style="color:${BRAND.text};font:400 12px/1.7 ${BRAND.font};margin:14px 0 0">${sigContact}</p>` : ''}
        </td></tr></tbody></table>`
    : '';

  /* — Unsub-footer (verplicht voor anti-spam compliance). */
  const unsubFooter = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tbody><tr>
    <td align="center" bgcolor="${BRAND.bgPage}" style="background-color:${BRAND.bgPage};padding:20px 25px">
      <p style="color:${BRAND.muted};font:400 11px/1.5 ${BRAND.font};margin:0">Je ontvangt deze mail omdat je je hebt ingeschreven in onze winkel. Wil je geen mails meer? Antwoord op deze e-mail of vraag in de winkel om uitschrijving.</p>
    </td></tr></tbody></table>`;

  /* — Full document. */
  return `<!doctype html>
<html lang="nl"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Welkom bij GENTS</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bgPage};font-family:${BRAND.font}">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BRAND.bgPage}">Welkom bij GENTS ${shortStore} — fijn dat je erbij bent.</div>
  <table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" bgcolor="${BRAND.bgPage}" style="background-color:${BRAND.bgPage}"><tbody><tr><td align="center" style="padding:0">
    <table align="center" width="600" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;background-color:${BRAND.bgWhite}"><tbody>
      <tr><td>${headerBlock}</td></tr>
      <tr><td>${menuBlock}</td></tr>
      ${heroUrl ? `<tr><td>${heroBlock}</td></tr>` : ''}
      <tr><td>${introBody}</td></tr>
      <tr><td>${ctaBlock}</td></tr>
      ${sigBlock ? `<tr><td>${sigBlock}</td></tr>` : ''}
      <tr><td>${unsubFooter}</td></tr>
    </tbody></table>
  </td></tr></tbody></table>
</body></html>`;
}

/* Sender e-mail + display-name samenstellen.
 *   Voorkeur: senderName + senderEmail uit config (bv. "Fosse Bakx | GENTS" +
 *   "fosse@gents.nl"). Backwards-compat: oude fromLocalPart wordt nog gelezen.
 */
function buildSenderEmail(storeCfg) {
  const direct = clean(storeCfg.senderEmail).toLowerCase();
  if (direct && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(direct)) return direct;
  /* Backwards-compat */
  const lp = clean(storeCfg.fromLocalPart || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (lp) {
    const domain = (process.env.GENTS_MAIL_DOMAIN || 'gents.nl').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `${lp}@${domain}`;
  }
  /* Laatste fallback */
  return 'hallo@gents.nl';
}

function buildSenderFromHeader(storeName, storeCfg) {
  const addr = buildSenderEmail(storeCfg);
  const customName = clean(storeCfg.senderName);
  /* Display-name: bv. "Fosse Bakx | GENTS" (voorkeur) of "GENTS Amsterdam"
     (fallback op store-naam als senderName leeg is). Headers safe maken. */
  const display = (customName || storeName || 'GENTS').replace(/[<>"]/g, '').trim();
  return `${display} <${addr}>`;
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
