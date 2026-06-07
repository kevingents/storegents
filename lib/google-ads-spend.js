/**
 * lib/google-ads-spend.js
 *
 * Haalt de Google Ads-advertentiekosten (spend) per periode op via GAQL, voor de
 * POAS-berekening op het Marketing-dashboard. Account-niveau (alle campagnes
 * samen), per dag. Faalt nooit hard: zonder volledige koppeling → {ok:false,
 * spend:null, error} zodat het dashboard alsnog omzet/marge kan tonen.
 */

import { gaql, readAdsConfig } from './google-ads-client.js';
import { listBranchesFromConfig } from './business-config.js';

const ymd = (d) => {
  const x = (d instanceof Date) ? d : new Date(d);
  return Number.isNaN(x.getTime()) ? '' : x.toISOString().slice(0, 10);
};
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ── Shopping vs Winkel-advertenties ────────────────────────────────────────
   Splitst Google Ads-campagnes in twee emmers voor het dashboard:
     shopping = product-/feed-advertenties (Shopping + Performance Max)
     winkel   = de rest (Search/Display/Video/Demand Gen) — merk/winkel-sturend
   Te overrulen op campagne-naam via env (komma-lijst, hoofdletterongevoelig):
     GOOGLE_ADS_SHOPPING_KEYWORDS, GOOGLE_ADS_WINKEL_KEYWORDS                   */
const SHOPPING_CHANNELS = new Set(['SHOPPING', 'PERFORMANCE_MAX']);
const kwList = (envVar) => String(process.env[envVar] || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/* Winkel-campagnes zijn herkenbaar aan de STAD — die halen we uit de centrale
   GENTS-config (één bron van waarheid), zodat je niks hoeft in te tikken. We
   matchen bewust alleen op de stad, niet op de volledige winkelnaam. */
let _winkelCities = null;
function winkelCityKeywords() {
  if (_winkelCities) return _winkelCities;
  const set = new Set();
  try {
    for (const b of (listBranchesFromConfig({ includeInternal: false }) || [])) {
      const store = String(b.store || '').toLowerCase().trim();
      if (!store) continue;
      const city = store.replace(/^gents\s+/, '').trim();   /* "GENTS Almere" → "almere" */
      if (city.length >= 4) set.add(city);
    }
  } catch (_) { /* config niet beschikbaar → val terug op env + kanaal */ }
  _winkelCities = [...set];
  return _winkelCities;
}

export function classifyAdBucket(campaign) {
  const name = String(campaign?.name || '').toLowerCase();
  /* 1. Handmatige winkel-override (env, komma-lijst). */
  if (kwList('GOOGLE_ADS_WINKEL_KEYWORDS').some((k) => name.includes(k))) return 'winkel';
  /* 2. Stad uit de GENTS-config in de naam → winkel-advertentie. */
  if (winkelCityKeywords().some((k) => name.includes(k))) return 'winkel';
  /* 3. Handmatige shopping-override (env). */
  if (kwList('GOOGLE_ADS_SHOPPING_KEYWORDS').some((k) => name.includes(k))) return 'shopping';
  /* 4. Kanaal: Shopping/Performance Max = shopping, de rest = winkel. */
  const channel = String(campaign?.channel || '').toUpperCase();
  return SHOPPING_CHANNELS.has(channel) ? 'shopping' : 'winkel';
}

function buildAdSplits(campaigns) {
  const mk = () => ({ spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0, campaigns: 0 });
  const out = { shopping: mk(), winkel: mk() };
  for (const c of (campaigns || [])) {
    const b = out[c.bucket] || out.winkel;
    b.spend += Number(c.spend || 0);
    b.impressions += Number(c.impressions || 0);
    b.clicks += Number(c.clicks || 0);
    b.conversions += Number(c.conversions || 0);
    b.conversionValue += Number(c.conversionValue || 0);
    b.campaigns += 1;
  }
  for (const k of ['shopping', 'winkel']) {
    out[k].spend = r2(out[k].spend);
    out[k].conversions = r2(out[k].conversions);
    out[k].conversionValue = r2(out[k].conversionValue);
  }
  return out;
}

/**
 * @param {{from:Date|string, to:Date|string}} range
 * @returns {Promise<{ok:boolean, spend:number|null, byDay:Array<{day,spend}>, currency?:string, customerId?:string, error?:string}>}
 */
export async function getGoogleAdsSpend({ from, to } = {}) {
  const cfg = readAdsConfig();
  if (!cfg.refreshToken || !cfg.developerToken || !cfg.customerId) {
    const mist = [
      !cfg.refreshToken && 'refresh token',
      !cfg.developerToken && 'developer token',
      !cfg.customerId && 'GOOGLE_ADS_CUSTOMER_ID'
    ].filter(Boolean).join(', ');
    return { ok: false, spend: null, byDay: [], error: `Google Ads niet volledig gekoppeld — ontbrekend: ${mist}.` };
  }
  const f = ymd(from), t = ymd(to);
  if (!f || !t) return { ok: false, spend: null, byDay: [], error: 'Ongeldige periode.' };

  const query = `SELECT segments.date, metrics.cost_micros FROM customer WHERE segments.date BETWEEN '${f}' AND '${t}'`;
  try {
    const rows = await gaql(query);
    const byDay = {};
    let micros = 0;
    for (const row of rows) {
      const day = row?.segments?.date || '';
      /* REST levert camelCase (costMicros); val terug op snake_case. */
      const c = Number(row?.metrics?.costMicros ?? row?.metrics?.cost_micros ?? 0);
      micros += c;
      if (day) byDay[day] = (byDay[day] || 0) + c;
    }
    return {
      ok: true,
      spend: r2(micros / 1e6),
      byDay: Object.entries(byDay).map(([day, m]) => ({ day, spend: r2(m / 1e6) })).sort((a, b) => a.day.localeCompare(b.day)),
      customerId: cfg.customerId
    };
  } catch (e) {
    return { ok: false, spend: null, byDay: [], error: e.message || 'Google Ads-spend ophalen mislukte.' };
  }
}

/**
 * Lopende Google Ads-campagnes (status ENABLED) met metrics over de periode.
 * @param {{from:Date|string, to:Date|string}} range
 * @returns {Promise<{ok:boolean, platform:'google', campaigns:Array, spend:number, error?:string}>}
 */
export async function getGoogleAdsCampaigns({ from, to } = {}) {
  const cfg = readAdsConfig();
  if (!cfg.refreshToken || !cfg.developerToken || !cfg.customerId) {
    return { ok: false, platform: 'google', campaigns: [], spend: 0, error: 'Google Ads niet volledig gekoppeld.' };
  }
  const f = ymd(from), t = ymd(to);
  if (!f || !t) return { ok: false, platform: 'google', campaigns: [], spend: 0, error: 'Ongeldige periode.' };

  const query = `SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions, metrics.conversions_value FROM campaign WHERE campaign.status = 'ENABLED' AND segments.date BETWEEN '${f}' AND '${t}'`;
  try {
    const rows = await gaql(query);
    /* GAQL geeft rijen per campagne×dag — aggregeer per campagne. */
    const map = new Map();
    for (const row of rows) {
      const c = row.campaign || {};
      const m = row.metrics || {};
      const id = String(c.id || '');
      if (!id) continue;
      const cur = map.get(id) || { id, name: c.name || id, status: c.status || 'ENABLED', channel: c.advertisingChannelType || c.advertising_channel_type || '', spend: 0, impressions: 0, clicks: 0, conversions: 0, conversionValue: 0 };
      cur.spend += Number(m.costMicros ?? m.cost_micros ?? 0) / 1e6;
      cur.impressions += Number(m.impressions || 0);
      cur.clicks += Number(m.clicks || 0);
      cur.conversions += Number(m.conversions || 0);
      cur.conversionValue += Number(m.conversionsValue ?? m.conversions_value ?? 0);
      map.set(id, cur);
    }
    const campaigns = [...map.values()]
      .map((c) => { const m = { ...c, spend: r2(c.spend), conversions: r2(c.conversions), conversionValue: r2(c.conversionValue) }; m.bucket = classifyAdBucket(m); return m; })
      .sort((a, b) => b.spend - a.spend);
    return { ok: true, platform: 'google', campaigns, splits: buildAdSplits(campaigns), spend: r2(campaigns.reduce((s, c) => s + c.spend, 0)), customerId: cfg.customerId };
  } catch (e) {
    return { ok: false, platform: 'google', campaigns: [], spend: 0, error: e.message || 'Google Ads-campagnes ophalen mislukte.' };
  }
}

/**
 * Zoektermen-rapport (search_term_view): waar geld weglekt aan zoekopdrachten
 * zonder conversie ("wasted spend"), plus de best converterende termen.
 * @param {{from:Date|string, to:Date|string}} range
 */
export async function getGoogleAdsSearchTerms({ from, to } = {}) {
  const cfg = readAdsConfig();
  if (!cfg.refreshToken || !cfg.developerToken || !cfg.customerId) {
    return { ok: false, wasted: [], topConverting: [], error: 'Google Ads niet volledig gekoppeld.' };
  }
  const f = ymd(from), t = ymd(to);
  if (!f || !t) return { ok: false, wasted: [], topConverting: [], error: 'Ongeldige periode.' };

  const query = `SELECT search_term_view.search_term, metrics.cost_micros, metrics.clicks, metrics.conversions, metrics.conversions_value FROM search_term_view WHERE segments.date BETWEEN '${f}' AND '${t}'`;
  try {
    const rows = await gaql(query);
    const map = new Map();
    for (const row of rows) {
      const term = String(row?.searchTermView?.searchTerm ?? row?.search_term_view?.search_term ?? '').trim();
      if (!term) continue;
      const m = row.metrics || {};
      const cur = map.get(term) || { term, spend: 0, clicks: 0, conversions: 0, conversionValue: 0 };
      cur.spend += Number(m.costMicros ?? m.cost_micros ?? 0) / 1e6;
      cur.clicks += Number(m.clicks || 0);
      cur.conversions += Number(m.conversions || 0);
      cur.conversionValue += Number(m.conversionsValue ?? m.conversions_value ?? 0);
      map.set(term, cur);
    }
    const terms = [...map.values()].map((x) => ({ term: x.term, spend: r2(x.spend), clicks: x.clicks, conversions: r2(x.conversions), conversionValue: r2(x.conversionValue) }));
    /* "Verspild" = wel uitgaven, (vrijwel) geen conversie. */
    const wasted = terms.filter((x) => x.spend > 0 && (x.conversions || 0) < 0.5).sort((a, b) => b.spend - a.spend);
    const topConverting = terms.filter((x) => (x.conversions || 0) >= 0.5).sort((a, b) => b.conversionValue - a.conversionValue);
    const totalSpend = r2(terms.reduce((s, x) => s + x.spend, 0));
    const wastedSpend = r2(wasted.reduce((s, x) => s + x.spend, 0));
    return {
      ok: true,
      termCount: terms.length,
      totalSpend,
      wastedSpend,
      wastedPct: totalSpend > 0 ? r2((wastedSpend / totalSpend) * 100) : null,
      wasted: wasted.slice(0, 30),
      topConverting: topConverting.slice(0, 15)
    };
  } catch (e) {
    return { ok: false, wasted: [], topConverting: [], error: e.message || 'Zoektermen ophalen mislukte.' };
  }
}
