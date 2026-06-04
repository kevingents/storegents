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
  markWelkomMailSent,
  markWelkomMailSentBatch,
  readSentMap
} from './welkom-mail-store.js';
void hasReceivedWelkomMail; void markWelkomMailSent; /* exports houden voor callers buiten cron */
import { getGoogleOpeningHoursForLocation, getGoogleReviewsForLocation } from './google-shopify-opening-hours.js';
import { getCustomerPersonalization } from './welkom-mail-personalization.js';

const clean = (v) => String(v == null ? '' : v).trim();
const cleanEmail = (e) => {
  const s = clean(e).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
};

/* Brand-kleuren (Spotler/MailPlus-stijl, 1:1 conform actieve nieuwsbrief-template). */
const BRAND = {
  text: '#0A1F33',         /* hoofdtekst */
  bgPage: '#F2F2F2',       /* outer mail-client background */
  bgSection: '#F5F5F2',    /* off-white content card */
  bgOuter: '#F9F9F9',      /* outer per-section bg (zoals Spotler) */
  bgHeader: '#000000',     /* zwart logo-blok */
  bgMenu: '#F5F5F2',       /* off-white categorieënrij */
  bgWhite: '#FFFFFF',
  ctaBg: '#0A1F33',        /* dark-navy knop */
  ctaText: '#FFFFFF',
  muted: '#475569',
  font: 'Verdana, Geneva, sans-serif'
};

/* Statische assets — gehost op MailPlus CDN (gehotlinked uit live nieuwsbrief).
   1:1 conform de chino-template die de gebruiker als referentie aanleverde. */
const ASSETS = {
  topFrame: 'https://content.mailplus.nl/m19/images/user111636/frame_59900.png',
  logoWit: 'https://content.mailplus.nl/m19/images/user111636/gents_logo_wit1.png',
  starBanner: 'https://content.mailplus.nl/m19/images/user111636/banner_1.png',
  winkelsImg: 'https://content.mailplus.nl/m19/images/user111636/winkels.png',
  footerLogo: 'https://content.mailplus.nl/m19/images/user111636/group.png'
};

/* Globale GENTS contact-info voor footer (algemeen, niet per winkel). */
const GENTS_CONTACT = {
  phone: '020 - 752 98 69',
  phoneTel: '0207529869',
  email: 'info@gents.nl',
  hours: 'Ma/vrij 09:00 17:00',
  facebookUrl: 'https://www.facebook.com/gentsshop',
  instagramUrl: 'https://www.instagram.com/gentsnl/',
  winkelsUrl: 'https://gents.nl/pages/winkels',
  reviewsUrl: 'https://www.google.com/search?q=GENTS+Reviews'
};

/* Statische 3 reviews (zelfde als chino-template). Later evt. configureerbaar. */
const STATIC_REVIEWS = [
  { title: 'Verbaasd over de kwaliteit', body: 'Verbaasd over de kwaliteit. Voor dit geld krijg je echt een goed shirt! Positieve ervaring, zijden strik ook erg mooi!' },
  { title: 'Goede professionele ondersteuning', body: 'Goede professionele ondersteuning, snelle levering.' },
  { title: 'Goed en vertrouwd bedrijf', body: 'Goed en vertrouwd bedrijf, met een mooi assortiment dat ook regelmatig vernieuwt. Duidelijke website en een makkelijk bestelproces. Goede betalingsmogelijkheden en snelle levering.' }
];

/* Formatteer Google opening-hours response naar nette HTML-rijen per dag.
   google-shopify-opening-hours.js gebruikt NEDERLANDSE day-keys ('maandag',
   'dinsdag', ..., 'zondag') — niet Engelse. Hier match je op die NL-keys
   zodat de waarden correct gepakt worden i.p.v. allemaal 'Gesloten'. */
const DAY_ORDER = ['maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag', 'zondag'];
const DAY_NL = { maandag: 'Maandag', dinsdag: 'Dinsdag', woensdag: 'Woensdag', donderdag: 'Donderdag', vrijdag: 'Vrijdag', zaterdag: 'Zaterdag', zondag: 'Zondag' };

function renderHoursTable(hoursJson) {
  if (!hoursJson || typeof hoursJson !== 'object') return '';
  const rows = DAY_ORDER.map((d) => {
    /* Probeer NL-key (van google-shopify-opening-hours.js) maar fall back op
       de Engelse variant voor backwards-compat met evt. andere bronnen. */
    const enKey = { maandag: 'monday', dinsdag: 'tuesday', woensdag: 'wednesday', donderdag: 'thursday', vrijdag: 'friday', zaterdag: 'saturday', zondag: 'sunday' }[d];
    const raw = clean(hoursJson[d]) || clean(hoursJson[enKey]) || '';
    /* Google retourneert 'gesloten' (kleine letter) voor dichte dagen; cap. */
    const val = raw && raw.toLowerCase() !== 'gesloten' ? raw : 'Gesloten';
    return `<tr><td style="padding:3px 14px 3px 0;color:${BRAND.muted};font:400 13px/1.5 ${BRAND.font}">${DAY_NL[d]}</td><td style="padding:3px 0;color:${BRAND.text};font:400 13px/1.5 ${BRAND.font}">${val}</td></tr>`;
  }).join('');
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" style="border-collapse:collapse;width:100%"><tbody>${rows}</tbody></table>`;
}

/* Probeer Google reviews op te halen voor 1 winkel. Returnt { rating,
   userRatingCount, reviews, writeReviewUrl } of null als geen Place ID of
   API faalt. Caller valt dan terug op STATIC_REVIEWS. */
async function tryGoogleReviews(storeName, storeCfg) {
  try {
    const placeId = clean(storeCfg.googlePlaceId);
    if (!placeId && !storeCfg.branchId) return null;
    const data = await getGoogleReviewsForLocation({
      placeId,
      branchId: clean(storeCfg.branchId),
      store: storeName
    }, { language: 'nl', timeoutMs: 12000, minRating: 4, max: 3 });
    if (data?.reviews?.length || data?.writeReviewUrl) return data;
  } catch (e) {
    console.warn(`[welkom-mail] Google reviews fetch faalde voor ${storeName}: ${e.message}`);
  }
  return null;
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
export { buildWelkomMailHtml, buildSenderFromHeader, tryGoogleOpeningHours, tryGoogleReviews };
export { getCustomerPersonalization } from './welkom-mail-personalization.js';

/* Shared mail-blocks (brand, assets, render-helpers) — gebruikt door pak-mail
   en andere transactionele automations. Eén stijlsysteem, één set assets. */
export const MAIL_BRAND = BRAND;
export const MAIL_ASSETS = ASSETS;
export const MAIL_GENTS_CONTACT = GENTS_CONTACT;
export { section as mailSection, infoBlock as mailInfoBlock, renderHeader as renderMailHeader, renderMenu as renderMailMenu, renderReviews as renderMailReviews, renderWinkels as renderMailWinkels, renderFooter as renderMailFooter, renderSignature as renderMailSignature, renderStars as renderMailStars, truncateText as mailTruncate };

/* Section-wrapper: zelfde outer bg + 600px container als de Spotler-template.
   Elke "sp-section" uit het XML wordt zo een mail-safe table-row. */
function section(innerHtml, bgInner = BRAND.bgWhite) {
  return `<table width="100%" border="0" cellpadding="0" cellspacing="0" role="presentation" bgcolor="${BRAND.bgOuter}" style="background-color:${BRAND.bgOuter}"><tbody><tr><td align="center">
    <table align="center" width="600" border="0" cellpadding="0" cellspacing="0" role="presentation" style="width:600px;max-width:600px;background-color:${bgInner}"><tbody>
      ${innerHtml}
    </tbody></table>
  </td></tr></tbody></table>`;
}

/* — HEADER: top-frame image + "Bekijk online" balk + GENTS-logo (zelfde als
   Spotler-template). */
function renderHeader() {
  return section(`
    <tr><td bgcolor="#F2F2F2" align="center" style="background-color:#F2F2F2;padding:3px">
      <img src="${ASSETS.topFrame}" alt="" width="594" style="display:block;width:594px;max-width:100%;height:auto;border:0">
    </td></tr>
    <tr><td align="center" bgcolor="${BRAND.bgHeader}" style="background-color:${BRAND.bgHeader};padding:10px">
      <p style="margin:0;color:#FFFFFF;font:400 13px/1.4 ${BRAND.font}">
        <a href="https://gents.nl" style="color:#FFFFFF;text-decoration:none">Bekijk de online versie</a>
      </p>
    </td></tr>
    <tr><td align="center" bgcolor="${BRAND.bgHeader}" style="background-color:${BRAND.bgHeader};padding:18px 15px 22px">
      <a href="https://gents.nl"><img src="${ASSETS.logoWit}" alt="GENTS" width="480" style="display:inline-block;width:480px;max-width:80%;height:auto;border:0"></a>
    </td></tr>
  `);
}

/* — MENU-RIJ: 4 categorieën Pakken/Overhemden/Colberts/Smokings, 1:1 conform
   Spotler-template (zelfde URLs). */
function renderMenu() {
  const menuCol = (label, href) => `<td align="center" bgcolor="${BRAND.bgMenu}" style="background-color:${BRAND.bgMenu};padding:10px;width:25%">
      <a href="${href}" style="color:${BRAND.text};font:400 14px/1.2 ${BRAND.font};text-decoration:none">${label}</a>
    </td>`;
  const row = `<tr>
    ${menuCol('Pakken', 'https://gents.nl/collections/pakken')}
    ${menuCol('Overhemden', 'https://gents.nl/collections/overhemden')}
    ${menuCol('Colberts', 'https://gents.nl/collections/colberts')}
    ${menuCol('Smokings', 'https://gents.nl/collections/smoking')}
  </tr>`;
  return section(`<tr><td bgcolor="${BRAND.bgMenu}" style="background-color:${BRAND.bgMenu};padding-bottom:6px">
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="border-collapse:collapse"><tbody>${row}</tbody></table>
  </td></tr>`);
}

/* — HERO: winkel-specifieke welkomstfoto (uit storeCfg.heroImageUrl). Geen
   hero = sectie wordt overgeslagen. */
function renderHero(storeCfg) {
  const heroUrl = clean(storeCfg.heroImageUrl);
  if (!heroUrl) return '';
  const heroLink = clean(storeCfg.heroImageLink) || clean(storeCfg.ctaUrl) || 'https://gents.nl';
  return section(`<tr><td align="center" bgcolor="${BRAND.bgWhite}" style="background-color:${BRAND.bgWhite}">
    <a href="${heroLink}" style="display:block;text-decoration:none"><img src="${heroUrl}" alt="Welkom bij GENTS" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a>
  </td></tr>`);
}

/* — PUNTEN-BLOK: huidige stand + voortgangsbalk naar volgende voucher.
   Alleen als personalisatie-data beschikbaar is. Conform brand-stijl (navy
   accent, off-white card, Verdana). */
function renderPointsBlock(points) {
  if (!points || !Number.isFinite(points.current)) return '';
  const cur = points.current;
  /* Max-tier bereikt = "Je hebt het maximum bereikt — gebruik je voucher!" */
  if (points.maxTierReached) {
    return infoBlock('Jouw spaarpunten', `<p style="margin:0;color:${BRAND.text};font:400 14px/1.6 ${BRAND.font}">Je hebt al <strong>${cur} punten</strong> gespaard — vraag in de winkel naar je beschikbare voucher.</p>`);
  }
  const target = points.nextTarget;
  const value = points.nextValue;
  const toGo = points.pointsToGo;
  const pct = Math.max(2, Math.min(100, points.progressPct));
  /* Progress-balk als tabel met 2 cellen (vulling + rest). Mail-safe. */
  const bar = `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="border-collapse:collapse;margin-top:10px;height:10px;background-color:#E5E7EB;border-radius:5px"><tbody><tr>
    <td bgcolor="${BRAND.ctaBg}" width="${pct}%" style="background-color:${BRAND.ctaBg};border-radius:5px;font-size:1px;line-height:1px;height:10px">&nbsp;</td>
    <td width="${100 - pct}%" style="font-size:1px;line-height:1px;height:10px">&nbsp;</td>
  </tr></tbody></table>`;
  const body = `
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tbody><tr>
      <td style="padding:0">
        <p style="margin:0;color:${BRAND.text};font:400 14px/1.6 ${BRAND.font}">Je hebt al <strong>${cur} punten</strong> gespaard. Nog <strong>${toGo} punten</strong> tot een voucher van <strong>€ ${value}</strong>.</p>
        ${bar}
        <p style="margin:8px 0 0;color:${BRAND.muted};font:400 12px/1.4 ${BRAND.font}">${cur} / ${target} punten</p>
      </td>
    </tr></tbody></table>`;
  return infoBlock('Jouw spaarpunten', body);
}

/* — SUGGESTED PRODUCTS sectie: 2x2 grid van bijpassende producten op basis
   van koopgedrag. Layout 1:1 conform chino-template (twee rijen van 2
   columns, sp-column width 268px met image + naam + prijs + SHOP NU knop). */
function renderSuggestedProducts(suggestedProducts) {
  if (!Array.isArray(suggestedProducts) || !suggestedProducts.length) return '';

  /* Per-product card matching de chino-template stijl. */
  const productCard = (p) => `<td width="50%" valign="top" align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:0 12px 20px;vertical-align:top">
      <a href="${p.url}" style="display:block;text-decoration:none">
        <img src="${p.image}" alt="${p.title.replace(/"/g, '')}" width="240" style="display:block;width:100%;max-width:240px;height:auto;border:0;border-radius:5px;margin:0 auto 15px">
      </a>
      <p style="margin:0;color:${BRAND.text};font:400 14px/1.5 ${BRAND.font};text-align:center">${p.title}</p>
      ${p.price ? `<p style="margin:8px 0 12px;color:${BRAND.text};font:400 13px/1.4 ${BRAND.font};text-align:center">${p.price}</p>` : '<p style="margin:8px 0 12px">&nbsp;</p>'}
      <table border="0" cellspacing="0" cellpadding="0" role="presentation" align="center" style="display:inline-table"><tbody><tr>
        <td align="center" bgcolor="${BRAND.ctaBg}" style="background-color:${BRAND.ctaBg};border-radius:7px;padding:10px 26px">
          <a href="${p.url}" style="color:${BRAND.ctaText};font:700 12px/1.2 ${BRAND.font};letter-spacing:1px;text-decoration:none">SHOP NU</a>
        </td></tr></tbody></table>
    </td>`;

  /* Splits in chunks van 2 voor de rij-layout. */
  const rows = [];
  for (let i = 0; i < suggestedProducts.length; i += 2) {
    const chunk = suggestedProducts.slice(i, i + 2);
    while (chunk.length < 2) chunk.push(null);
    rows.push(`<tr>${chunk.map((p) => p ? productCard(p) : `<td width="50%" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection}">&nbsp;</td>`).join('')}</tr>`);
  }

  return section(`
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:40px 20px 8px">
      <h2 style="color:${BRAND.text};font:700 20px/1.3 ${BRAND.font};margin:0">VOOR JOU GESELECTEERD</h2>
      <p style="color:${BRAND.text};font:400 13px/1.5 ${BRAND.font};margin:10px 20px 0">Op basis van wat je eerder bij ons hebt gekocht.</p>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:20px 8px 30px">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="border-collapse:collapse"><tbody>
        ${rows.join('')}
      </tbody></table>
    </td></tr>
  `, BRAND.bgSection);
}

/* — WELKOM-CONTENT: "Hey {voornaam}," + intro + info-blokken (openingstijden,
   vermaak, loyalty, punten, voucher) + dark-navy CTA-knop. */
function renderWelkomContent(customer, storeName, storeCfg, opts) {
  opts = opts || {};
  const voornaam = clean(customer.firstName || customer.voornaam || '');
  const groet = voornaam ? `Hey&nbsp;${voornaam},` : 'Hey,';
  const shortStore = storeName.replace(/^GENTS\s+/i, '');
  /* Punten-blok uit personalisatie (welkom-mail-personalization.js). */
  const pointsBlok = opts.personalization ? renderPointsBlock(opts.personalization.points) : '';

  /* Info-blokken (alleen renderen als er content is). */
  const openingBody = opts.googleHoursHtml
    ? `${opts.googleHoursHtml}${opts.googleMapsUrl ? `<div style="margin-top:10px"><a href="${opts.googleMapsUrl}" style="color:${BRAND.text};font:600 12px/1 ${BRAND.font};text-decoration:underline">Bekijk op Google Maps</a></div>` : ''}`
    : (clean(storeCfg.openingHours) ? clean(storeCfg.openingHours) : '');
  const openingBlok = openingBody ? infoBlock('Openingstijden', openingBody) : '';
  const alterationsBlok = clean(storeCfg.alterationsInfo) ? infoBlock('Vermaakkosten &amp; service', clean(storeCfg.alterationsInfo)) : '';
  const loyaltyBlok = clean(storeCfg.loyaltyInfo) ? infoBlock('Punten sparen voor vouchers', clean(storeCfg.loyaltyInfo)) : '';

  /* Voucher = donker-navy badge. */
  const voucherBlock = clean(storeCfg.voucherCode)
    ? `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="margin-top:18px"><tbody><tr>
        <td align="center" bgcolor="${BRAND.text}" style="background-color:${BRAND.text};padding:20px 24px">
          <div style="color:#FFFFFF;font:600 11px/1 ${BRAND.font};letter-spacing:2px;text-transform:uppercase">Welkomstcadeau</div>
          <div style="color:#FFFFFF;font:700 28px/1.1 ${BRAND.font};letter-spacing:3px;margin-top:10px">${clean(storeCfg.voucherCode)}</div>
          <div style="color:#D1D5DB;font:400 12px/1.4 ${BRAND.font};margin-top:8px">Gebruik bij je volgende bezoek of online bestelling.</div>
        </td></tr></tbody></table>`
    : '';

  const ctaUrl = clean(storeCfg.ctaUrl) || 'https://gents.nl';
  const ctaLabel = clean(storeCfg.ctaLabel) || 'BEZOEK ONZE WEBSHOP';
  const ctaButton = `<table border="0" cellspacing="0" cellpadding="0" role="presentation" align="center" style="display:inline-table"><tbody><tr>
    <td align="center" bgcolor="${BRAND.ctaBg}" style="background-color:${BRAND.ctaBg};border-radius:7px;padding:12px 30px">
      <a href="${ctaUrl}" style="color:${BRAND.ctaText};font:700 14px/1.2 ${BRAND.font};letter-spacing:1px;text-decoration:none">${ctaLabel}</a>
    </td></tr></tbody></table>`;

  return section(`
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:40px 20px 20px">
      <h1 style="color:${BRAND.text};font:700 20px/1.25 ${BRAND.font};margin:0">${groet}</h1>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:10px 25px">
      <p style="color:${BRAND.text};font:400 14px/1.6 ${BRAND.font};margin:0">Welkom bij <strong>GENTS ${shortStore}</strong>. Fijn dat je je hebt ingeschreven — vanaf nu houden we je op de hoogte van nieuwe collecties, persoonlijke styling-tips en bijzondere events bij ons in de winkel.</p>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:14px 25px 6px">
      <p style="color:${BRAND.text};font:400 14px/1.6 ${BRAND.font};margin:0">Hieronder een paar dingen die handig zijn om te weten over onze winkel.</p>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:0 25px">
      ${openingBlok}
      ${alterationsBlok}
      ${loyaltyBlok}
      ${pointsBlok}
      ${voucherBlock}
    </td></tr>
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:24px 25px 36px">
      ${ctaButton}
    </td></tr>
  `, BRAND.bgSection);
}

/* — Render 5 sterren als unicode (★ vol, ☆ leeg). Email-safe. */
function renderStars(rating) {
  const r = Math.round(Number(rating) || 0);
  const filled = Math.max(0, Math.min(5, r));
  return `<span style="color:#F59E0B;font-size:16px;letter-spacing:1px;line-height:1">${'★'.repeat(filled)}${'☆'.repeat(5 - filled)}</span>`;
}

/* — Verkort een review-tekst naar maxLen tekens (op woord-grens). */
function truncateText(text, maxLen = 220) {
  const t = clean(text);
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > maxLen * 0.6 ? cut.slice(0, lastSpace) : cut) + '…';
}

/* — REVIEWS sectie: gebruikt live Google-reviews indien beschikbaar, anders
   STATIC_REVIEWS. Onderaan altijd CTA-knop "Schrijf een review op Google"
   die naar het Google review-formulier voor die specifieke winkel linkt. */
function renderReviews(googleReviews) {
  const useGoogle = googleReviews && Array.isArray(googleReviews.reviews) && googleReviews.reviews.length > 0;
  const writeUrl = googleReviews?.writeReviewUrl || GENTS_CONTACT.reviewsUrl;
  const overallRating = useGoogle && googleReviews.rating ? googleReviews.rating : 4.9;
  const reviewCount = useGoogle && googleReviews.userRatingCount ? googleReviews.userRatingCount : 1081;
  const reviewCountText = reviewCount > 0
    ? `uit ${reviewCount.toLocaleString('nl-NL')} beoordelingen`
    : 'uit onze klant-reviews';

  /* Per-review card. Google = author + ster-rating + verkorte tekst + relatieve tijd.
     Static = titel + body (fallback als geen Google-data). */
  const googleReviewCol = (r) => `<td width="33%" valign="top" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:10px 12px 40px;vertical-align:top">
      <div style="margin-bottom:10px">${renderStars(r.rating)}</div>
      <p style="color:${BRAND.text};font:700 14px/1.4 ${BRAND.font};margin:0"><strong>${clean(r.author) || 'GENTS-klant'}</strong>${r.relativeTime ? `<br><span style="font-weight:400;font-size:11.5px;color:${BRAND.muted}">${clean(r.relativeTime)}</span>` : ''}</p>
      <p style="color:${BRAND.text};font:400 13px/1.5 ${BRAND.font};margin:8px 0 0">${truncateText(r.text)}</p>
    </td>`;
  const staticReviewCol = (r) => `<td width="33%" valign="top" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:10px 12px 40px;vertical-align:top">
      <a href="${writeUrl}" style="text-decoration:none"><img src="${ASSETS.starBanner}" alt="" width="136" style="display:block;max-width:100%;height:auto;border:0;margin-bottom:14px"></a>
      <p style="color:${BRAND.text};font:700 14px/1.4 ${BRAND.font};margin:0"><strong>${r.title}</strong></p>
      <p style="color:${BRAND.text};font:400 13px/1.5 ${BRAND.font};margin:8px 0 0">${r.body}</p>
    </td>`;

  const reviewCells = useGoogle
    ? googleReviews.reviews.slice(0, 3).map(googleReviewCol).join('')
    : STATIC_REVIEWS.map(staticReviewCol).join('');

  /* CTA-knop: opent het Google review-formulier direct via
     search.google.com/local/writereview?placeid=… */
  const writeReviewCta = `<table border="0" cellspacing="0" cellpadding="0" role="presentation" align="center" style="display:inline-table"><tbody><tr>
    <td align="center" bgcolor="${BRAND.ctaBg}" style="background-color:${BRAND.ctaBg};border-radius:7px;padding:12px 28px">
      <a href="${writeUrl}" style="color:${BRAND.ctaText};font:700 13px/1.2 ${BRAND.font};letter-spacing:1px;text-decoration:none">SCHRIJF EEN REVIEW OP GOOGLE</a>
    </td></tr></tbody></table>`;

  return section(`
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:40px 20px 10px">
      <h2 style="color:${BRAND.text};font:700 20px/1.3 ${BRAND.font};margin:0">WAT ONZE KLANTEN ZEGGEN</h2>
    </td></tr>
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:14px 20px 6px">
      <div style="margin-bottom:8px">${renderStars(overallRating)}</div>
      <p style="color:${BRAND.text};font:400 13px/1.5 ${BRAND.font};margin:0">${overallRating ? `<strong>${overallRating.toFixed(1).replace('.', ',')}</strong> · ` : ''}${reviewCountText}</p>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:15px 8px 20px">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="border-collapse:collapse"><tbody><tr>
        ${reviewCells}
      </tr></tbody></table>
    </td></tr>
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:0 20px 32px">
      <p style="color:${BRAND.text};font:400 13.5px/1.5 ${BRAND.font};margin:0 0 14px">Was je tevreden over je bezoek? Help ons door een review achter te laten!</p>
      ${writeReviewCta}
    </td></tr>
  `, BRAND.bgSection);
}

/* — WINKELS: "BEZOEK EEN GENTS BIJ JOU IN DE BUURT" met winkels-afbeelding +
   tekst + BEKIJK WINKELS knop. Conform Spotler-template. */
function renderWinkels() {
  return section(`
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:20px 0">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tbody><tr>
        <td width="50%" valign="middle" style="vertical-align:middle;padding:0 10px 0 20px">
          <a href="${GENTS_CONTACT.winkelsUrl}"><img src="${ASSETS.winkelsImg}" alt="GENTS winkels" width="270" style="display:block;max-width:100%;height:auto;border:0"></a>
        </td>
        <td width="50%" valign="middle" style="vertical-align:middle;padding:8px 20px">
          <h2 style="color:${BRAND.text};font:700 18px/1.3 ${BRAND.font};margin:0">BEZOEK EEN GENTS BIJ JOU IN DE BUURT</h2>
          <p style="color:${BRAND.text};font:400 14px/1.5 ${BRAND.font};margin:14px 0 0">In onze <strong>winkels</strong> krijg je persoonlijk advies en service met aandacht. We helpen je graag met maat, stijl en combinaties voor elke gelegenheid.</p>
          <p style="color:${BRAND.text};font:400 14px/1.5 ${BRAND.font};margin:10px 0 0">Ook kun je je kleding direct <strong>vakkundig laten vermaken</strong>.</p>
          <table border="0" cellspacing="0" cellpadding="0" role="presentation" align="left" style="margin-top:15px;display:inline-table"><tbody><tr>
            <td align="center" bgcolor="${BRAND.ctaBg}" style="background-color:${BRAND.ctaBg};border-radius:7px;padding:11px 22px">
              <a href="${GENTS_CONTACT.winkelsUrl}" style="color:${BRAND.ctaText};font:700 13px/1.2 ${BRAND.font};letter-spacing:1px;text-decoration:none">BEKIJK WINKELS</a>
            </td></tr></tbody></table>
        </td>
      </tr></tbody></table>
    </td></tr>
  `, BRAND.bgSection);
}

/* — PERSOONLIJKE AFSLUITING: signature van de winkel-medewerker (alleen als
   signatureName gevuld is). */
function renderSignature(storeCfg) {
  const sigName = clean(storeCfg.signatureName);
  if (!sigName) return '';
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

  return section(`<tr><td bgcolor="${BRAND.bgWhite}" style="background-color:${BRAND.bgWhite};padding:28px 30px;border-top:1px solid #E5E7EB">
    <p style="color:${BRAND.text};font:400 13px/1.5 ${BRAND.font};margin:0">Met vriendelijke groet,</p>
    <p style="color:${BRAND.text};font:700 16px/1.3 ${BRAND.font};margin:14px 0 0">${sigName}</p>
    ${sigRole ? `<p style="color:${BRAND.text};font:400 13px/1.4 ${BRAND.font};margin:2px 0 0">${sigRole} | <a href="https://gents.nl" style="color:${BRAND.text};text-decoration:none"><strong>www.gents.nl</strong></a></p>` : ''}
    ${sigContact ? `<p style="color:${BRAND.text};font:400 12px/1.7 ${BRAND.font};margin:14px 0 0">${sigContact}</p>` : ''}
  </td></tr>`);
}

/* — FOOTER: zwart blok met GENTS-logo wit + contact-info (Ma/vrij, telefoon,
   email) + "Volg je ons al?" + social icons + afmelden-link. */
function renderFooter() {
  /* Inline social icons als witte cirkels met Facebook/Instagram tekens. */
  const socialIcon = (href, char) => `<a href="${href}" style="display:inline-block;width:32px;height:32px;line-height:32px;text-align:center;background:#FFFFFF;color:${BRAND.bgHeader};border-radius:50%;text-decoration:none;font:700 16px/32px Arial;margin:0 6px">${char}</a>`;

  return section(`
    <tr><td bgcolor="${BRAND.bgHeader}" style="background-color:${BRAND.bgHeader};padding:10px 0 5px">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%"><tbody><tr>
        <td width="50%" valign="middle" align="center" style="padding:25px 20px;vertical-align:middle">
          <a href="https://gents.nl"><img src="${ASSETS.footerLogo}" alt="GENTS" width="240" style="display:block;max-width:100%;height:auto;border:0"></a>
        </td>
        <td width="50%" valign="middle" align="center" style="padding:25px 20px;vertical-align:middle">
          <p style="color:#FFFFFF;font:700 13px/1.5 ${BRAND.font};margin:0;text-align:center"><strong>Contact</strong></p>
          <p style="color:#FFFFFF;font:400 13px/1.5 ${BRAND.font};margin:6px 0 0;text-align:center">${GENTS_CONTACT.hours}</p>
          <p style="font:400 13px/1.5 ${BRAND.font};margin:6px 0 0;text-align:center"><a href="tel:${GENTS_CONTACT.phoneTel}" style="color:#FFFFFF;text-decoration:none">${GENTS_CONTACT.phone}</a></p>
          <p style="font:400 13px/1.5 ${BRAND.font};margin:6px 0 0;text-align:center"><a href="mailto:${GENTS_CONTACT.email}" style="color:#FFFFFF;text-decoration:none">${GENTS_CONTACT.email}</a></p>
        </td>
      </tr></tbody></table>
    </td></tr>
    <tr><td align="center" bgcolor="${BRAND.bgHeader}" style="background-color:${BRAND.bgHeader};padding:5px 20px 15px">
      <p style="color:#FFFFFF;font:700 13px/1.5 ${BRAND.font};margin:0 0 12px"><strong>Volg je ons al?</strong></p>
      <div>${socialIcon(GENTS_CONTACT.facebookUrl, 'f')}${socialIcon(GENTS_CONTACT.instagramUrl, '@')}</div>
    </td></tr>
    <tr><td align="center" bgcolor="${BRAND.bgHeader}" style="background-color:${BRAND.bgHeader};padding:10px 20px 20px">
      <p style="color:#FFFFFF;font:400 11px/1.5 ${BRAND.font};margin:0">Je ontvangt deze mail omdat je je hebt ingeschreven in onze winkel. Wil je geen mails meer? <a href="mailto:${GENTS_CONTACT.email}?subject=Afmelden%20welkom-mail" style="color:#FFFFFF;text-decoration:underline">Afmelden</a> of vraag in de winkel om uitschrijving.</p>
    </td></tr>
  `);
}

/* Bouw de welkom-mail HTML in volledige Spotler/MailPlus stijl (1:1 conform de
   chino-template-referentie van de gebruiker). Volledig table-based voor mail-
   client compatibility. */
function buildWelkomMailHtml(customer, storeName, storeCfg, opts) {
  opts = opts || {};
  const shortStore = storeName.replace(/^GENTS\s+/i, '');
  const voornaam = clean(customer.firstName || customer.voornaam || '');
  const greetingHint = voornaam ? `Hey ${voornaam}, welkom bij GENTS ${shortStore}.` : `Welkom bij GENTS ${shortStore}.`;

  return `<!doctype html>
<html lang="nl"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Welkom bij GENTS</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bgPage};font-family:${BRAND.font};color:${BRAND.text}">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BRAND.bgPage}">${greetingHint}</div>
  ${renderHeader()}
  ${renderMenu()}
  ${renderHero(storeCfg)}
  ${renderWelkomContent(customer, storeName, storeCfg, opts)}
  ${opts.personalization ? renderSuggestedProducts(opts.personalization.suggestedProducts) : ''}
  ${renderReviews(opts.googleReviews)}
  ${renderWinkels()}
  ${renderSignature(storeCfg)}
  ${renderFooter()}
</body></html>`;
}

/* Sender e-mail + display-name samenstellen.
 *   Voorkeur: senderName + senderEmail uit config (bv. "GENTS Amsterdam" +
 *   "amsterdam@mail.gents.nl"). Zonder senderEmail bouwt deze automatisch
 *   `{winkel}@mail.gents.nl` op basis van de store-naam — werkt voor elke
 *   winkel zonder per-winkel config. Backwards-compat: oude fromLocalPart
 *   wordt nog gelezen als beide leeg zijn.
 */
function buildSenderEmail(storeName, storeCfg) {
  const direct = clean(storeCfg.senderEmail).toLowerCase();
  if (direct && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(direct)) return direct;
  /* Auto-genereer uit store-naam: "GENTS Amsterdam" → "amsterdam@mail.gents.nl". */
  const domain = (process.env.GENTS_MAIL_DOMAIN || 'mail.gents.nl').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const shortStore = clean(storeName).replace(/^GENTS\s+/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (shortStore) return `${shortStore}@${domain}`;
  /* Backwards-compat */
  const lp = clean(storeCfg.fromLocalPart || '').toLowerCase().replace(/[^a-z0-9._-]/g, '');
  if (lp) return `${lp}@${domain}`;
  /* Laatste fallback */
  return `hallo@${domain}`;
}

function buildSenderFromHeader(storeName, storeCfg) {
  const addr = buildSenderEmail(storeName, storeCfg);
  const customName = clean(storeCfg.senderName);
  /* Display-name: bv. "GENTS Amsterdam" (voorkeur senderName) of fallback op
     store-naam. Headers safe maken (geen < > " in display-name). */
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

  /* RACE FIX: laad sent-map 1× per run in-memory. Daarmee dedupliceren we
     binnen deze run (zelfde email niet 2× in dezelfde batch) én tegen alle
     eerder verzonden mails — zonder N+1 blob reads. */
  const sentMap = await readSentMap().catch(() => ({ sent: {} }));
  const sentSet = new Set(Object.keys(sentMap.sent || {}));
  const claimedThisRun = new Set();    /* in-memory claim vóór sendMail */
  const pendingBatch = [];             /* op te slaan na elke winkel */

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

    /* Eén Google-fetch per winkel (niet per klant) → cache voor deze run.
       Parallel: openingstijden + reviews (allebei via Google Places API). */
    const [googleHours, googleReviews] = await Promise.all([
      tryGoogleOpeningHours(storeName, storeCfg),
      tryGoogleReviews(storeName, storeCfg)
    ]);
    const mailOpts = {};
    if (googleHours) {
      mailOpts.googleHoursHtml = googleHours.html;
      mailOpts.googleMapsUrl = googleHours.googleMapsUrl;
    }
    if (googleReviews) mailOpts.googleReviews = googleReviews;

    let storeSent = 0, storeSkippedAlready = 0, storeSkippedNoMail = 0, storeErr = 0;
    for (const c of (customers || [])) {
      if (totalSent >= cap) break outer;
      const email = cleanEmail(c.email);
      if (!email) { storeSkippedNoMail += 1; totalSkippedNoMail += 1; continue; }
      const opt = clean(c.allowMailings) === 'true' || c.allowMailings === true;
      if (!opt) { totalSkippedNoOptIn += 1; continue; }
      /* Dedup tegen reeds verzonden (blob, 1× geladen) + tegen huidige run
         (parallel cron-trigger of dubbele klant in SRS-resultaat). */
      if (sentSet.has(email) || claimedThisRun.has(email)) { storeSkippedAlready += 1; totalSkippedAlready += 1; continue; }
      /* Claim VOOR send — zo voorkomen we dat 2 parallel-loops dezelfde
         klant beide oppakken als de send langer dan 1 cron-tick duurt. */
      claimedThisRun.add(email);

      if (dryRun) {
        samples.push({ email, store: storeName, voornaam: clean(c.firstName), branchId });
        storeSent += 1; totalSent += 1;
        continue;
      }

      try {
        /* Per-klant personalisatie: punten + suggested products (best-effort,
           gooit nooit — bij fout returnt het {points:null, suggestedProducts:[]}). */
        const personalization = await getCustomerPersonalization(c).catch(() => null);
        const html = buildWelkomMailHtml(c, storeName, storeCfg, { ...mailOpts, personalization });
        const result = await sendMail({
          to: email,
          subject: clean(storeCfg.subject) || `Welkom bij ${storeName}`,
          html,
          from: buildSenderFromHeader(storeName, storeCfg),
          headers: { 'X-Welkom-Mail': 'gents-welkom-v1', 'X-Welkom-Store': storeName }
        });
        /* Verzameld voor batch-write na de winkel (1 blob-write per N mails
           ipv N+1 calls). Sent-set lokaal ook updaten. */
        pendingBatch.push({
          email,
          store: storeName,
          branchId,
          messageId: result?.id || result?.messageId || ''
        });
        sentSet.add(email);
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

    /* Batch-write na elke winkel (kleinere lots = minder kans op
       conflict bij retry, en partial progress als 1 winkel faalt). */
    if (!dryRun && pendingBatch.length) {
      try {
        await markWelkomMailSentBatch(pendingBatch.splice(0));
      } catch (e) {
        console.warn(`[welkom-mail] batch sent-blob write faalde: ${e.message}`);
      }
    }
  }

  /* Veiligheidsnet: als er nog iets in pendingBatch zit (b.v. break outer
     vóór de winkel-flush), schrijf het hier nog weg. */
  if (!dryRun && pendingBatch.length) {
    try {
      await markWelkomMailSentBatch(pendingBatch.splice(0));
    } catch (e) {
      console.warn(`[welkom-mail] final sent-blob flush faalde: ${e.message}`);
    }
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
