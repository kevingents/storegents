/**
 * lib/bol-insights.js
 *
 * Omzet & inzichten voor bol: echte verkopen/omzet (Orders), best-sellers,
 * buy-box-positie + bezoeken (Insights), performance-score en PRIJSPARITEIT.
 *
 * GENTS-regel: de bol-prijs moet GELIJK zijn aan de webshop-prijs (incl.
 * verzendkosten), zodat bol nooit goedkoper is dan gents.nl — we concurreren
 * niet met onszelf. We onderbieden dus NOOIT om de buy box te pakken; we
 * bewaken pariteit (bol = webshop + verzending) en signaleren afwijkingen.
 *
 * Read-only: advies, schrijft niets. Alle bol-calls zijn defensief.
 */

import { bolGet, isBolConfigured } from './bol-client.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { getBolSettings } from './bol-settings-store.js';

const PATH = 'marketplace/bol-insights.json';
const OFFER_MAP_PATH = 'marketplace/bol-offer-map.json';
const MAX_AGE_MS = Number(process.env.BOL_INSIGHTS_MAX_AGE_MS || 12 * 60 * 60 * 1000);
const COMPETING_PATH = (process.env.BOL_COMPETING_PATH || '/products/{ean}/offers'); /* get-competing-offers */
const BUYBOX_DREMPEL = Number(process.env.BOL_BUYBOX_MIN || 90); /* % onder deze waarde = aandacht */

const clean = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;

/** EAN → { titel, webshopPrijs } uit de Shopify-cache. */
async function cacheByEan() {
  const cache = await readProductsCache().catch(() => null);
  const m = new Map();
  for (const v of Object.values(cache?.byBarcode || {})) {
    const ean = clean(v.barcode);
    if (ean && !m.has(ean)) m.set(ean, { titel: clean(v.title), webshopPrijs: num(v.price) || null });
  }
  return m;
}
/** Pariteitsprijs = webshop-prijs + verzendkosten (bol mag niet goedkoper zijn). */
function pariteit(webshopPrijs, surcharge) { return webshopPrijs != null ? r2(webshopPrijs + (Number(surcharge) || 0)) : null; }

/* Loop een willekeurig bol-antwoord af en verzamel numerieke meetwaarden. */
function collectValues(obj, key) {
  const out = [];
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (Array.isArray(o)) { o.forEach(walk); return; }
    for (const [k, val] of Object.entries(o)) {
      if ((k === 'value' || k === 'quantity' || k === key) && typeof val === 'number') out.push(val);
      else if (val && typeof val === 'object') walk(val);
    }
  };
  walk(obj);
  return out;
}
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

/* ── Echte verkopen + omzet uit de Orders API (best-effort, gepagineerd). ── */
async function fetchSales({ maxPages = 25 } = {}) {
  const byEan = new Map();
  let stuks = 0, omzet = 0, orders = 0;
  for (let page = 1; page <= maxPages; page++) {
    let resp;
    try { resp = await bolGet('/orders', { query: { status: 'ALL' }, page }); } catch { break; }
    const list = resp?.orders || [];
    if (!list.length) break;
    orders += list.length;
    for (const o of list) {
      for (const it of (o.orderItems || o.items || [])) {
        const ean = clean(it.ean || it.product?.ean);
        if (!ean) continue;
        const q = num(it.quantity) || 1;
        const p = num(it.unitPrice ?? it.price?.amount ?? it.price);
        const cur = byEan.get(ean) || { ean, aantal: 0, omzet: 0 };
        cur.aantal += q; cur.omzet += q * p;
        byEan.set(ean, cur);
        stuks += q; omzet += q * p;
      }
    }
    if (list.length < 50) break;
  }
  return { byEan, stuks, omzet, orders };
}

/* ── Buy box % + bezoeken per offer (Insights). ───────────────────────── */
async function offerMetric(offerId, name, periods = 7) {
  try {
    const resp = await bolGet('/insights/offer', { query: { 'offer-id': offerId, period: 'DAY', 'number-of-periods': periods, name } });
    return avg(collectValues(resp));
  } catch { return null; }
}

/** Bouw het volledige inzichten-rapport (cachebaar). */
export async function runBolInsights({ topN = 60 } = {}) {
  if (!isBolConfigured()) return { configured: false, reason: 'bol niet gekoppeld' };
  const cache = await cacheByEan();
  const settings = await getBolSettings();
  const SURCHARGE = Number(settings.shippingSurcharge) || 0;
  const TOL = Number(settings.parityTolerance) || 0.02;
  const titles = new Map([...cache].map(([ean, v]) => [ean, v.titel]));
  const offerMap = (await readJsonBlob(OFFER_MAP_PATH, null))?.byEan || {};

  /* Prijspariteit: bol-prijs vs webshop-prijs (+ verzendkosten). bol mag NIET
     goedkoper zijn dan de webshop (zelf-concurrentie). */
  const pariteitAfwijkingen = [];
  let teGoedkoop = 0, teDuur = 0;
  for (const [ean, o] of Object.entries(offerMap)) {
    const bolPrijs = num(o.prijs) || null;
    const web = cache.get(ean)?.webshopPrijs ?? null;
    const par = pariteit(web, SURCHARGE);
    if (bolPrijs == null || par == null) continue;
    const verschil = r2(bolPrijs - par);
    if (Math.abs(verschil) <= TOL) continue;
    if (verschil < 0) teGoedkoop += 1; else teDuur += 1;
    pariteitAfwijkingen.push({ ean, titel: cache.get(ean)?.titel || '', bolPrijs, webshopPrijs: web, pariteitPrijs: par, verschil, soort: verschil < 0 ? 'te goedkoop' : 'te duur' });
  }
  pariteitAfwijkingen.sort((a, b) => a.verschil - b.verschil); /* meest te goedkoop eerst (urgent) */

  /* Performance-indicatoren (bol-gezondheidsscore). */
  let performance = [];
  try {
    const perf = await bolGet('/insights/performance/indicator', { query: { name: 'ALL' } });
    performance = (perf?.performanceIndicators || perf?.indicators || []).map((p) => ({
      naam: clean(p.name || p.type), score: clean(p.score?.value ?? p.value ?? p.score), norm: clean(p.norm?.value ?? p.norm), status: clean(p.score?.distance ?? p.status)
    }));
  } catch { /* leeg */ }

  /* Verkopen + best-sellers. */
  const sales = await fetchSales();
  const bestsellers = [...sales.byEan.values()]
    .map((s) => ({ ...s, titel: titles.get(s.ean) || '', offerId: offerMap[s.ean]?.offerId || null }))
    .sort((a, b) => b.omzet - a.omzet)
    .slice(0, 200);

  /* Buy box + bezoeken voor de topverkopers (anders alle offers, gelimiteerd). */
  const buyboxBron = bestsellers.length ? bestsellers : Object.entries(offerMap).map(([ean, o]) => ({ ean, titel: titles.get(ean) || '', offerId: o.offerId }));
  const buybox = [];
  for (const it of buyboxBron.slice(0, topN)) {
    if (!it.offerId) continue;
    const [bb, visits] = await Promise.all([
      offerMetric(it.offerId, 'BUY_BOX_PERCENTAGE'),
      offerMetric(it.offerId, 'PRODUCT_VISITS')
    ]);
    if (bb == null && visits == null) continue;
    const conversie = (visits && it.aantal) ? (it.aantal / visits) * 100 : null;
    buybox.push({ ean: it.ean, titel: it.titel, offerId: it.offerId, buyboxPct: bb == null ? null : Math.round(bb), bezoeken: visits == null ? null : Math.round(visits), conversiePct: conversie == null ? null : Math.round(conversie * 10) / 10 });
  }
  const buyboxVerliezers = buybox.filter((b) => b.buyboxPct != null && b.buyboxPct < BUYBOX_DREMPEL).sort((a, b) => (a.buyboxPct || 0) - (b.buyboxPct || 0));

  const result = {
    refreshedAt: new Date().toISOString(),
    configured: true,
    omzet: Math.round(sales.omzet * 100) / 100,
    stuks: sales.stuks,
    orders: sales.orders,
    performance,
    bestsellers: bestsellers.slice(0, 100),
    buybox,
    buyboxVerliezers: buyboxVerliezers.slice(0, 50),
    drempel: BUYBOX_DREMPEL,
    pariteit: {
      verzendkosten: SURCHARGE,
      teGoedkoop, /* bol goedkoper dan webshop = zelf-concurrentie */
      teDuur,
      afwijkingen: pariteitAfwijkingen.slice(0, 200)
    }
  };
  try { await writeJsonBlob(PATH, result); } catch (_) {}
  return result;
}

export async function readBolInsights() { return readJsonBlob(PATH, null); }
export function isInsightsFresh(p) { return p?.refreshedAt && (Date.now() - new Date(p.refreshedAt).getTime()) < MAX_AGE_MS; }

/**
 * Prijspariteit-advies voor één EAN. GENTS-regel: de bol-prijs = webshop-prijs
 * + verzendkosten — bol mag NOOIT goedkoper zijn dan gents.nl (geen zelf-
 * concurrentie) en niet onnodig duurder (anders mis je bol-omzet). De buy-box-
 * prijs wordt erbij getoond als INFO; we onderbieden niet. Schrijft niets.
 */
export async function getRepriceAdvice(ean) {
  if (!isBolConfigured()) throw new Error('bol niet gekoppeld.');
  const e = clean(ean);
  const [cache, settings] = await Promise.all([cacheByEan(), getBolSettings()]);
  const SURCHARGE = Number(settings.shippingSurcharge) || 0;
  const TOL = Number(settings.parityTolerance) || 0.02;
  const offerMap = (await readJsonBlob(OFFER_MAP_PATH, null))?.byEan || {};
  const bolPrijs = num(offerMap[e]?.prijs) || null;
  const webshopPrijs = cache.get(e)?.webshopPrijs ?? null;
  const pariteitPrijs = pariteit(webshopPrijs, SURCHARGE);

  /* Buy-box-prijs ophalen als INFO (niet om te onderbieden). */
  let buyBoxPrijs = null, aantalOffers = 0;
  try {
    const raw = await bolGet(COMPETING_PATH.replace('{ean}', e));
    const offers = (raw?.offers || raw?.competingOffers || []).map((o) => ({
      prijs: num(o.price ?? o.bundlePrices?.[0]?.price ?? o.pricing?.bundlePrices?.[0]?.price),
      bestOffer: Boolean(o.bestOffer ?? o.buyBox)
    })).filter((o) => o.prijs > 0);
    aantalOffers = offers.length;
    const winnaar = offers.find((o) => o.bestOffer) || offers.slice().sort((a, b) => a.prijs - b.prijs)[0] || null;
    buyBoxPrijs = winnaar ? winnaar.prijs : null;
  } catch { /* info-only, niet kritiek */ }

  let advies;
  if (pariteitPrijs == null) advies = 'Geen webshop-prijs bekend — kan pariteit niet bepalen.';
  else if (bolPrijs == null) advies = `Zet de bol-prijs op €${pariteitPrijs.toFixed(2)} (= webshop €${(webshopPrijs || 0).toFixed(2)}${SURCHARGE ? ` + €${SURCHARGE.toFixed(2)} verzending` : ''}).`;
  else if (Math.abs(bolPrijs - pariteitPrijs) <= TOL) advies = `Pariteit klopt — bol €${bolPrijs.toFixed(2)} ≈ webshop €${pariteitPrijs.toFixed(2)}.`;
  else if (bolPrijs < pariteitPrijs) advies = `bol (€${bolPrijs.toFixed(2)}) is GOEDKOPER dan de webshop-pariteit (€${pariteitPrijs.toFixed(2)}) — je concurreert met jezelf. Verhoog naar €${pariteitPrijs.toFixed(2)}.`;
  else advies = `bol (€${bolPrijs.toFixed(2)}) is duurder dan de pariteit (€${pariteitPrijs.toFixed(2)}) — verlaag naar €${pariteitPrijs.toFixed(2)} om geen bol-omzet te missen.`;

  return { ean: e, webshopPrijs, verzendkosten: SURCHARGE, pariteitPrijs, onzePrijs: bolPrijs, buyBoxPrijs, adviesPrijs: pariteitPrijs, advies, aantalOffers };
}
