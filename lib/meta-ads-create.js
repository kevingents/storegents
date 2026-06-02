/**
 * lib/meta-ads-create.js
 *
 * Maakt een advertentie ("boost") van een bestaande Instagram-post via de Meta
 * Marketing API. ALLES wordt op status PAUSED aangemaakt — er wordt dus nooit
 * automatisch geld uitgegeven. De gebruiker activeert zelf in Ads Manager.
 *
 * Flow: campagne (PAUSED) → advertentieset (PAUSED, dagbudget + doelgroep) →
 * advertentiemateriaal (bestaande IG-post) → advertentie (PAUSED). Geeft de
 * IDs + een directe Ads-Manager-link terug.
 *
 * Vereist op het System-User-token de scope `ads_management` (naast ads_read +
 * instagram_basic). Faalt graceful: elke stap die misgaat → { ok:false, error }
 * met de tot dan toe aangemaakte IDs (alles PAUSED, dus veilig).
 *
 * Vercel-env (secrets): META_ADS_ACCESS_TOKEN, META_ADS_ACCOUNT_ID,
 *   INSTAGRAM_BUSINESS_ID, META_APP_SECRET (optioneel), META_ADS_API_VERSION.
 */

import crypto from 'crypto';
import { getInstagramToken } from './gala-instagram.js';

const clean = (v) => String(v == null ? '' : v).trim();

function cfg() {
  const raw = clean(process.env.META_ADS_ACCOUNT_ID || process.env.META_AD_ACCOUNT_ID);
  const account = raw ? (raw.startsWith('act_') ? raw : 'act_' + raw.replace(/\D/g, '')) : '';
  return {
    token: clean(process.env.META_ADS_ACCESS_TOKEN || process.env.META_ACCESS_TOKEN || process.env.INSTAGRAM_GRAPH_TOKEN) || getInstagramToken(),
    account,
    accountNum: account.replace(/\D/g, ''),
    igId: clean(process.env.INSTAGRAM_BUSINESS_ID || process.env.IG_BUSINESS_ID),
    appSecret: clean(process.env.META_APP_SECRET),
    version: clean(process.env.META_ADS_API_VERSION) || 'v21.0'
  };
}

/* Doel → ODAX-objective + optimalisatie. Engagement en bereik zijn het veiligst
   voor een post-boost; verkeer stuurt naar de site (post moet een link hebben). */
const GOALS = {
  interactie: { objective: 'OUTCOME_ENGAGEMENT', optimization_goal: 'POST_ENGAGEMENT', billing_event: 'IMPRESSIONS' },
  bereik: { objective: 'OUTCOME_AWARENESS', optimization_goal: 'REACH', billing_event: 'IMPRESSIONS' },
  verkeer: { objective: 'OUTCOME_TRAFFIC', optimization_goal: 'LINK_CLICKS', billing_event: 'IMPRESSIONS' }
};

function appProof(c) {
  return c.appSecret ? crypto.createHmac('sha256', c.appSecret).update(c.token).digest('hex') : null;
}

async function metaGet(c, path, fields, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const p = new URLSearchParams();
    if (fields) p.set('fields', fields);
    p.set('access_token', c.token);
    const proof = appProof(c); if (proof) p.set('appsecret_proof', proof);
    const r = await fetch(`https://graph.facebook.com/${c.version}/${path}?${p.toString()}`, { signal: ctrl.signal });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) { const e = new Error((j.error && j.error.message) || `HTTP ${r.status}`); e.meta = j.error || null; throw e; }
    return j;
  } finally { clearTimeout(tmr); }
}

async function metaPost(c, path, body, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const tmr = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const form = new URLSearchParams();
    for (const [k, v] of Object.entries(body)) form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    form.set('access_token', c.token);
    const proof = appProof(c); if (proof) form.set('appsecret_proof', proof);
    const r = await fetch(`https://graph.facebook.com/${c.version}/${path}`, { method: 'POST', body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.error) {
      const err = j.error || {};
      /* error_user_msg/title bevatten de échte (leesbare) reden; message is vaak
         alleen "Invalid parameter". Combineer ze zodat de gebruiker iets ziet. */
      const detail = err.error_user_msg || err.error_user_title || err.message || `HTTP ${r.status}`;
      const e = new Error(detail);
      e.meta = err;
      e.subcode = err.error_subcode || null;
      e.fbtrace = err.fbtrace_id || null;
      throw e;
    }
    return j;
  } finally { clearTimeout(tmr); }
}

/* De Facebook-pagina die aan het IG-businessaccount hangt (nodig voor het
   advertentiemateriaal). */
async function resolvePageId(c) {
  const j = await metaGet(c, 'me/accounts', 'name,id,instagram_business_account{id},connected_instagram_account{id}');
  const pages = j.data || [];
  const match = pages.find((p) => {
    const iba = p.instagram_business_account || p.connected_instagram_account;
    return iba && String(iba.id) === String(c.igId);
  }) || pages[0];
  return match ? { pageId: match.id, pageName: match.name || null } : { pageId: null, pageName: null };
}

const adsManagerUrl = (c, campaignId) =>
  `https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=${c.accountNum}&selected_campaign_ids=${campaignId}`;

/**
 * Maak een PAUSED boost-campagne van een bestaande IG-post.
 *
 * @param {object} o
 * @param {string} o.mediaId        IG-media-id (po.id uit social-stats).
 * @param {number} o.dailyBudgetEur dagbudget in euro (min 1, default 10).
 * @param {number} [o.days]         looptijd in dagen (0/leeg = geen einddatum).
 * @param {string} [o.goal]         'interactie' | 'bereik' | 'verkeer'.
 * @param {string[]} [o.countries]  landcodes (default ['NL']).
 * @param {number} [o.ageMin]       default 18.
 * @param {number} [o.ageMax]       default 65.
 * @param {string} [o.caption]      korte omschrijving voor de namen.
 * @param {string} [o.linkUrl]      bestemmings-URL (alleen voor doel 'verkeer').
 */
export async function createPausedBoost(o = {}) {
  const c = cfg();
  const created = {};
  if (!c.token) return { ok: false, error: 'Geen Meta-token (META_ADS_ACCESS_TOKEN).' };
  if (!c.account) return { ok: false, error: 'META_ADS_ACCOUNT_ID ontbreekt (act_…).' };
  if (!c.igId) return { ok: false, error: 'INSTAGRAM_BUSINESS_ID ontbreekt.' };
  const mediaId = clean(o.mediaId);
  if (!mediaId) return { ok: false, error: 'Geen post gekozen (mediaId ontbreekt).' };

  const goalKey = GOALS[clean(o.goal)] ? clean(o.goal) : 'interactie';
  const goal = GOALS[goalKey];
  const eur = Math.max(1, Number(o.dailyBudgetEur) || 10);
  const dailyBudget = Math.round(eur * 100); // minor units (cent)
  const countries = (Array.isArray(o.countries) && o.countries.length ? o.countries : ['NL']).map((x) => clean(x).toUpperCase()).filter(Boolean);
  const ageMin = Math.min(65, Math.max(13, Number(o.ageMin) || 18));
  const ageMax = Math.min(65, Math.max(ageMin, Number(o.ageMax) || 65));
  const days = Math.max(0, Math.min(90, Number(o.days) || 0));
  const tag = clean(o.caption).slice(0, 40) || mediaId;

  /* Elke stap met een label, zodat een fout zegt wélke stap faalde. */
  const post = async (step, path, body) => {
    try { return await metaPost(c, path, body); }
    catch (e) { e.step = step; throw e; }
  };

  try {
    /* 1. Pagina opzoeken (voor het materiaal). */
    let pageId, pageName;
    try { ({ pageId, pageName } = await resolvePageId(c)); }
    catch (e) { e.step = 'pagina opzoeken'; throw e; }
    if (!pageId) return { ok: false, error: 'Geen Facebook-pagina gekoppeld aan het IG-account gevonden (wijs de pagina toe aan de System User).' };
    created.pageId = pageId;

    /* 2. Campagne (PAUSED). */
    const camp = await post('campagne', `${c.account}/campaigns`, {
      name: `Boost · ${tag} · ${goalKey}`,
      objective: goal.objective,
      status: 'PAUSED',
      special_ad_categories: []
    });
    created.campaignId = camp.id;

    /* 3. Advertentieset (PAUSED) — dagbudget + doelgroep, alleen Instagram. */
    const targeting = {
      geo_locations: { countries },
      age_min: ageMin,
      age_max: ageMax,
      publisher_platforms: ['instagram']
    };
    const adsetBody = {
      name: `Boost-set · ${tag}`,
      campaign_id: camp.id,
      daily_budget: dailyBudget,
      billing_event: goal.billing_event,
      optimization_goal: goal.optimization_goal,
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting,
      status: 'PAUSED'
    };
    if (days > 0) {
      /* Unix-timestamps (seconden) zijn betrouwbaarder dan ISO bij de Marketing API. */
      const nowSec = Math.floor(Date.now() / 1000);
      adsetBody.start_time = nowSec + 600;
      adsetBody.end_time = nowSec + days * 86400;
    }
    const adset = await post('advertentieset', `${c.account}/adsets`, adsetBody);
    created.adsetId = adset.id;

    /* 4. Advertentiemateriaal van de bestaande IG-post. De veldnaam voor het
       IG-account verschilt per API-versie (instagram_user_id ↔ instagram_actor_id),
       dus proberen we beide. */
    const oss = (key) => {
      const spec = { page_id: pageId };
      spec[key] = c.igId;
      if (goalKey === 'verkeer' && clean(o.linkUrl)) spec.link_data = { link: clean(o.linkUrl) };
      return spec;
    };
    const creativeBase = { name: `Boost-creative · ${tag}`, source_instagram_media_id: mediaId };
    let creative;
    try {
      creative = await post('materiaal', `${c.account}/adcreatives`, { ...creativeBase, object_story_spec: oss('instagram_user_id') });
    } catch (e1) {
      try { creative = await post('materiaal', `${c.account}/adcreatives`, { ...creativeBase, object_story_spec: oss('instagram_actor_id') }); }
      catch (e2) { throw e1; }
    }
    created.creativeId = creative.id;

    /* 5. Advertentie (PAUSED). */
    const ad = await post('advertentie', `${c.account}/ads`, {
      name: `Boost-ad · ${tag}`,
      adset_id: adset.id,
      creative: { creative_id: creative.id },
      status: 'PAUSED'
    });
    created.adId = ad.id;

    return {
      ok: true,
      ...created,
      pageName,
      goal: goalKey,
      dailyBudgetEur: eur,
      days,
      countries,
      adsManagerUrl: adsManagerUrl(c, camp.id),
      message: 'Advertentie aangemaakt op PAUSED. Controleer en activeer in Ads Manager.'
    };
  } catch (e) {
    const msg = e.message || 'Boost aanmaken mislukte.';
    let hint = null;
    if (/permission|ads_management|(#200)|(#10)\b/i.test(msg)) {
      hint = 'Het token mist waarschijnlijk de scope ads_management — voeg die toe aan de System User en genereer het token opnieuw.';
    } else if (e.step === 'advertentieset') {
      hint = 'Controleer of het advertentieaccount actief is met een geldige betaalmethode, en of het account in EUR staat (dagbudget/landen kloppen anders niet).';
    } else if (e.step === 'materiaal') {
      hint = 'De post is mogelijk niet promootbaar (geen openbare feed-post, of het IG-account is niet juist gekoppeld aan de pagina).';
    }
    return {
      ok: false,
      error: (e.step ? `[${e.step}] ` : '') + msg,
      step: e.step || null,
      metaError: e.meta || null,
      subcode: e.subcode || null,
      fbtrace: e.fbtrace || null,
      created,
      adsManagerUrl: created.campaignId ? adsManagerUrl(c, created.campaignId) : null,
      hint
    };
  }
}

/* Lichtgewicht status-check (zonder iets te maken): token/account/igId aanwezig +
   pagina vindbaar. Voor de frontend om de boost-knop wel/niet te tonen. */
export async function boostReadiness() {
  const c = cfg();
  const out = { hasToken: !!c.token, hasAccount: !!c.account, hasIg: !!c.igId };
  out.configured = out.hasToken && out.hasAccount && out.hasIg;
  if (!out.configured) return out;
  try {
    const { pageId, pageName } = await resolvePageId(c);
    out.pageId = pageId; out.pageName = pageName; out.pageOk = !!pageId;
  } catch (e) { out.pageOk = false; out.pageError = e.message; }
  return out;
}
