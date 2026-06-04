/**
 * lib/pak-mail-automation.js
 *
 * Post-purchase pak-mail flow. 7 dagen na aankoop van een pak wordt een
 * persoonlijke mail verstuurd met verzorgingstips, uithang-instructies,
 * vermaak-info en bijpassende producten (incl. coupon).
 *
 * Pipeline:
 *   1. findPakBuyers(window [delayDays-1, delayDays+1] dagen geleden)
 *   2. Filter: email, allowMailings, niet binnen cooldownDays al pak-mail gehad
 *   3. Per klant: bouw mail (header + hero + content-blocks + suggesties + footer)
 *   4. Verstuur via Resend met tag category=pak-mail voor engagement-tracking
 *   5. Batch-write sent-blob na de run
 */

import { sendMail } from './gents-mailer.js';
import {
  MAIL_BRAND as BRAND,
  MAIL_GENTS_CONTACT as GENTS_CONTACT,
  MAIL_ASSETS as ASSETS,
  mailSection as section,
  renderMailHeader,
  renderMailMenu,
  renderMailReviews,
  renderMailWinkels,
  renderMailFooter,
  renderMailSignature,
  buildSenderFromHeader,
  tryGoogleReviews
} from './welkom-mail-automation.js';
import {
  getPakMailConfig,
  readPakMailSentMap,
  markPakMailSentBatch,
  isWithinCooldown,
  PAK_MAIL_DEFAULTS
} from './pak-mail-store.js';
import { findPakBuyers } from './pak-purchase-detector.js';
import { readProductsCache } from './shopify-products-cache.js';
import { branchIdToStoreName } from './business-config.js';

void PAK_MAIL_DEFAULTS;
const clean = (v) => String(v == null ? '' : v).trim();

/* ─── Suggested products (complementary categories voor een pak) ─────── */

/* Welke categorieën combineren goed bij een pak. MVP fixed lijst — later
   evt. AI-driven of seizoens-aware. Hoofdgroep-aliassen lower-case. */
const COMPLEMENTARY_GROEPEN = new Set([
  'overhemden', 'overhemd', 'shirts', 'shirt',
  'stropdassen', 'stropdas', 'dassen', 'das',
  'pochetten', 'pochet',
  'riemen', 'riem',
  'schoenen', 'schoen'
]);

function djb2Hash(str) {
  let h = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  return Math.abs(h);
}

/* Pak max 4 bijpassende producten uit complementary categories. Deterministisch
   per email zodat dezelfde klant niet random andere suggesties krijgt. */
async function findComplementaryProducts(email, max = 4) {
  try {
    const cache = await readProductsCache();
    const productList = Array.isArray(cache?.products) ? cache.products
      : Array.isArray(cache) ? cache : [];
    const candidates = productList.filter((p) => {
      const cat = clean(p.hoofdgroep).toLowerCase() || clean(p.productType).toLowerCase();
      if (!COMPLEMENTARY_GROEPEN.has(cat)) return false;
      const v0 = (p.variants || [])[0];
      return v0 && clean(v0.image) && v0.price;
    });
    if (!candidates.length) return [];
    const seed = djb2Hash(email);
    return candidates
      .map((p, i) => ({ p, key: djb2Hash(`${seed}-${p.productId || i}`) }))
      .sort((a, b) => a.key - b.key)
      .slice(0, max)
      .map(({ p }) => {
        const v = p.variants[0];
        const handle = clean(p.handle);
        const price = Number(v.price || 0);
        return {
          title: clean(p.title || v.title || 'GENTS'),
          image: clean(v.image),
          price: price > 0 ? `€ ${price.toFixed(2).replace('.', ',')}` : '',
          url: handle ? `https://gents.nl/products/${handle}` : 'https://gents.nl'
        };
      });
  } catch (e) {
    console.warn(`[pak-mail] complementary products faalde: ${e.message}`);
    return [];
  }
}

/* ─── Render-helpers (pak-specifieke blocks) ──────────────────────────── */

/* Genummerd content-blok: titel + body (HTML toegestaan). Wordt overgeslagen
   als body leeg is — zo kan de admin per winkel selectief blokken aanzetten. */
function contentBlock(num, title, bodyHtml) {
  if (!clean(bodyHtml)) return '';
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="margin-top:18px"><tbody><tr>
    <td bgcolor="${BRAND.bgWhite}" style="background-color:${BRAND.bgWhite};padding:20px 22px;border:1px solid #E5E7EB">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px">
        <span style="display:inline-flex;width:26px;height:26px;align-items:center;justify-content:center;background:${BRAND.text};color:#FFFFFF;border-radius:50%;font:700 13px/1 ${BRAND.font}">${num}</span>
        <strong style="color:${BRAND.text};font:700 14px/1.3 ${BRAND.font};text-transform:uppercase;letter-spacing:.5px">${title}</strong>
      </div>
      <div style="color:${BRAND.text};font:400 14px/1.6 ${BRAND.font}">${bodyHtml}</div>
    </td></tr></tbody></table>`;
}

/* Coupon-blok: dark-navy badge met code, label en geldigheid. */
function couponBlock(cfg) {
  const code = clean(cfg.couponCode);
  if (!code) return '';
  const label = clean(cfg.couponLabel) || 'Gratis verzending bij je volgende bestelling';
  const expiry = clean(cfg.couponExpiry) || '';
  return `<table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="margin-top:18px"><tbody><tr>
    <td align="center" bgcolor="${BRAND.text}" style="background-color:${BRAND.text};padding:22px 24px">
      <div style="color:#FFFFFF;font:600 11px/1 ${BRAND.font};letter-spacing:2px;text-transform:uppercase">${label}</div>
      <div style="color:#FFFFFF;font:700 30px/1.1 ${BRAND.font};letter-spacing:3px;margin-top:12px">${code}</div>
      ${expiry ? `<div style="color:#D1D5DB;font:400 12px/1.4 ${BRAND.font};margin-top:8px">${expiry}</div>` : ''}
    </td></tr></tbody></table>`;
}

/* Bijpassende producten (2x2 grid). Hergebruik patroon uit welkom-mail
   suggested products, maar met "BEKIJK" label ipv "SHOP NU" voor variatie. */
function renderSuggestedSection(products) {
  if (!Array.isArray(products) || !products.length) return '';
  const card = (p) => `<td width="50%" valign="top" align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:0 12px 20px;vertical-align:top">
      <a href="${p.url}" style="display:block;text-decoration:none">
        <img src="${p.image}" alt="${p.title.replace(/"/g, '')}" width="240" style="display:block;width:100%;max-width:240px;height:auto;border:0;border-radius:5px;margin:0 auto 15px">
      </a>
      <p style="margin:0;color:${BRAND.text};font:400 14px/1.5 ${BRAND.font};text-align:center">${p.title}</p>
      ${p.price ? `<p style="margin:8px 0 12px;color:${BRAND.text};font:400 13px/1.4 ${BRAND.font};text-align:center">${p.price}</p>` : '<p style="margin:8px 0 12px">&nbsp;</p>'}
      <table border="0" cellspacing="0" cellpadding="0" role="presentation" align="center" style="display:inline-table"><tbody><tr>
        <td align="center" bgcolor="${BRAND.ctaBg}" style="background-color:${BRAND.ctaBg};border-radius:7px;padding:10px 24px">
          <a href="${p.url}" style="color:${BRAND.ctaText};font:700 12px/1.2 ${BRAND.font};letter-spacing:1px;text-decoration:none">BEKIJK</a>
        </td></tr></tbody></table>
    </td>`;
  const rows = [];
  for (let i = 0; i < products.length; i += 2) {
    const chunk = products.slice(i, i + 2);
    while (chunk.length < 2) chunk.push(null);
    rows.push(`<tr>${chunk.map((p) => p ? card(p) : `<td width="50%" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection}">&nbsp;</td>`).join('')}</tr>`);
  }
  return section(`
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:40px 20px 8px">
      <h2 style="color:${BRAND.text};font:700 20px/1.3 ${BRAND.font};margin:0">BIJPASSENDE ARTIKELEN</h2>
      <p style="color:${BRAND.text};font:400 13px/1.5 ${BRAND.font};margin:10px 20px 0">Maak je outfit compleet met deze klassiekers — handgekozen door onze styling-experts.</p>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:20px 8px 30px">
      <table cellpadding="0" cellspacing="0" border="0" role="presentation" width="100%" style="border-collapse:collapse"><tbody>
        ${rows.join('')}
      </tbody></table>
    </td></tr>
  `, BRAND.bgSection);
}

/* Hero-sectie: optionele banner + groet + intro. */
function renderPakHero(customer, cfg) {
  const voornaam = clean(customer.firstName || '');
  const groet = voornaam ? `Hey&nbsp;${voornaam},` : 'Hey,';
  const heroUrl = clean(cfg.heroImageUrl);
  const heroLink = clean(cfg.heroImageLink) || 'https://gents.nl';
  const heroImg = heroUrl
    ? section(`<tr><td align="center" bgcolor="${BRAND.bgWhite}" style="background-color:${BRAND.bgWhite}">
        <a href="${heroLink}" style="display:block;text-decoration:none"><img src="${heroUrl}" alt="Jouw nieuwe pak" width="600" style="display:block;width:100%;max-width:600px;height:auto;border:0"></a>
      </td></tr>`)
    : '';

  const introHtml = clean(cfg.introText) || PAK_MAIL_DEFAULTS.introText;
  const intro = section(`
    <tr><td align="center" bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:40px 20px 20px">
      <h1 style="color:${BRAND.text};font:700 22px/1.25 ${BRAND.font};margin:0">${groet}</h1>
    </td></tr>
    <tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:0 25px 24px">
      <p style="color:${BRAND.text};font:400 14px/1.6 ${BRAND.font};margin:0">${introHtml}</p>
    </td></tr>
  `, BRAND.bgSection);

  return heroImg + intro;
}

/* Content-stack: 4 vaste blocks + 1 optioneel "vul zelf aan" block. */
function renderContentBlocks(cfg) {
  const blocks = [
    contentBlock(1, clean(cfg.unboxingTitle) || 'Net uit de doos', clean(cfg.unboxingText)),
    contentBlock(2, clean(cfg.careTitle) || 'Verzorging', clean(cfg.careText)),
    contentBlock(3, clean(cfg.alterationsTitle) || 'Maat niet perfect?', clean(cfg.alterationsText)),
    /* Block 4 = coupon (visueel anders dan info-blokken). */
    couponBlock(cfg),
    /* Block 5 = optionele "vul zelf aan" door admin. */
    contentBlock(4, clean(cfg.extraTitle) || 'Goed om te weten', clean(cfg.extraText))
  ].filter(Boolean);

  if (!blocks.length) return '';
  return section(`<tr><td bgcolor="${BRAND.bgSection}" style="background-color:${BRAND.bgSection};padding:0 25px 24px">${blocks.join('')}</td></tr>`, BRAND.bgSection);
}

/* ─── Public: render volledige pak-mail HTML ──────────────────────────── */

export function buildPakMailHtml(customer, cfg, opts = {}) {
  const products = Array.isArray(opts.suggestedProducts) ? opts.suggestedProducts : [];
  const heroPlusIntro = renderPakHero(customer, cfg);
  const contentStack = renderContentBlocks(cfg);
  const suggested = renderSuggestedSection(products);
  const reviews = renderMailReviews(opts.googleReviews);
  const winkels = renderMailWinkels();
  const sigStoreCfg = {
    senderEmail: cfg.senderEmail,
    signatureName: cfg.signatureName,
    signatureRole: cfg.signatureRole,
    signaturePhone: cfg.signaturePhone,
    signatureMobile: cfg.signatureMobile,
    addressLine: cfg.addressLine
  };
  const signature = renderMailSignature(sigStoreCfg);

  return `<!doctype html>
<html lang="nl"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Je nieuwe pak — alles wat je moet weten</title>
</head>
<body style="margin:0;padding:0;background-color:${BRAND.bgPage};font-family:${BRAND.font};color:${BRAND.text}">
  <div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:${BRAND.bgPage}">Bedankt voor je pak bij GENTS — een paar tips voor maximaal pak-plezier.</div>
  ${renderMailHeader()}
  ${renderMailMenu()}
  ${heroPlusIntro}
  ${contentStack}
  ${suggested}
  ${reviews}
  ${winkels}
  ${signature}
  ${renderMailFooter()}
</body></html>`;
}

/* ─── Hoofd-flow: scan kandidaten + verstuur ──────────────────────────── */

export async function runPakMailAutomation({ dryRun = false, maxPerRun, onlyEmail = '' } = {}) {
  const cfgFull = await getPakMailConfig();
  const cfg = cfgFull.config;
  if (!cfg.enabled && !dryRun) {
    return { success: true, message: 'Pak-mail is uitgeschakeld in config.', sent: 0, dryRun };
  }

  const cap = Math.max(1, Number(maxPerRun || cfgFull.maxPerRun || 50));
  const delayDays = Math.max(0, Number(cfg.delayDays || 7));
  const lookback = Math.max(delayDays + 1, Number(cfgFull.lookbackDays || 30));

  /* Detectie-window: vandaag - lookback dagen tot en met vandaag - delayDays. */
  const now = Date.now();
  const dayMs = 24 * 3600 * 1000;
  const fromDate = new Date(now - lookback * dayMs).toISOString().slice(0, 10);
  const untilDate = new Date(now - delayDays * dayMs).toISOString().slice(0, 10);

  let candidates = [];
  try {
    candidates = await findPakBuyers({ fromDate, untilDate });
  } catch (e) {
    return { success: false, message: `Pak-detect faalde: ${e.message}`, sent: 0 };
  }
  if (onlyEmail) {
    const e = clean(onlyEmail).toLowerCase();
    candidates = candidates.filter((c) => c.email === e);
  }

  /* Sent-map 1× laden voor cooldown check (idem patroon als welkom-mail). */
  const sentMap = await readPakMailSentMap();
  const claimedThisRun = new Set();
  const pendingBatch = [];

  let sent = 0, skippedCooldown = 0, errors = 0;
  const samples = [];

  /* Eén Google reviews-fetch voor alle mails (algemene reviews, niet per
     winkel — pak-mail komt van overkoepelend GENTS, niet 1 winkel). */
  let googleReviews = null;
  try {
    googleReviews = await tryGoogleReviews('GENTS', { branchId: '15' }); /* default fallback Amsterdam */
  } catch {}

  for (const c of candidates) {
    if (sent >= cap) break;
    if (!c.email) continue;
    const sentEntry = sentMap.sent?.[c.email];
    if (sentEntry && isWithinCooldown(sentEntry, cfg.cooldownDays || 180)) {
      skippedCooldown += 1;
      continue;
    }
    if (claimedThisRun.has(c.email)) { skippedCooldown += 1; continue; }
    claimedThisRun.add(c.email);

    if (dryRun) {
      samples.push({ email: c.email, voornaam: c.firstName, branchId: c.branchId, sku: c.sku, store: branchIdToStoreName(c.branchId) || '' });
      sent += 1;
      continue;
    }

    /* Bijpassende producten per klant (deterministisch via email-seed). */
    const products = await findComplementaryProducts(c.email, 4);
    const html = buildPakMailHtml(c, cfg, { suggestedProducts: products, googleReviews });
    const fromHeader = buildSenderFromHeader('GENTS', { senderName: cfg.senderName, senderEmail: cfg.senderEmail });

    try {
      const result = await sendMail({
        to: c.email,
        subject: clean(cfg.subject) || 'Je nieuwe pak — alles wat je moet weten',
        html,
        from: fromHeader,
        headers: { 'X-Pak-Mail': 'gents-pak-v1', 'X-Pak-SKU': c.sku || '', 'X-Pak-Branch': c.branchId || '' },
        tags: [
          { name: 'category', value: 'pak-mail' },
          { name: 'branch', value: c.branchId || 'unknown' }
        ]
      });
      pendingBatch.push({
        email: c.email,
        sku: c.sku,
        orderId: c.orderId,
        branchId: c.branchId,
        messageId: result?.id || result?.messageId || ''
      });
      sent += 1;
      if (samples.length < 10) samples.push({ email: c.email, messageId: result?.id || '', branchId: c.branchId });
    } catch (e) {
      errors += 1;
      if (samples.length < 10) samples.push({ email: c.email, error: e.message?.slice(0, 200) });
    }
  }

  if (!dryRun && pendingBatch.length) {
    try { await markPakMailSentBatch(pendingBatch); }
    catch (e) { console.warn(`[pak-mail] batch sent-blob write faalde: ${e.message}`); }
  }

  return {
    success: true,
    dryRun,
    window: { fromDate, untilDate, delayDays, lookbackDays: lookback },
    candidates: candidates.length,
    sent,
    skippedCooldown,
    errors,
    samples
  };
}
