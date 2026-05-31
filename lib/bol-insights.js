/**
 * lib/bol-insights.js
 *
 * Omzet & inzichten voor bol: echte verkopen/omzet (Orders), best-sellers,
 * buy-box-positie + bezoeken (Insights), performance-score en repricing-advies
 * t.o.v. de buy-box-winnaar (Competing offers) — met een veilige prijsbodem.
 *
 * Read-only behalve het (optionele) repricing, dat als advies wordt getoond.
 * Alle bol-calls zijn defensief: ontbreekt iets, dan blijft dat blok leeg.
 */

import { bolGet, isBolConfigured } from './bol-client.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';

const PATH = 'marketplace/bol-insights.json';
const OFFER_MAP_PATH = 'marketplace/bol-offer-map.json';
const MAX_AGE_MS = Number(process.env.BOL_INSIGHTS_MAX_AGE_MS || 12 * 60 * 60 * 1000);
const COMPETING_PATH = (process.env.BOL_COMPETING_PATH || '/products/{ean}/offers'); /* get-competing-offers */
const BUYBOX_DREMPEL = Number(process.env.BOL_BUYBOX_MIN || 90); /* % onder deze waarde = aandacht */
const PRICE_FLOOR_FACTOR = Number(process.env.BOL_PRICE_FLOOR_FACTOR || 0.85); /* nooit onder 85% van onze huidige prijs */

const clean = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };

async function titleByEan() {
  const cache = await readProductsCache().catch(() => null);
  const m = new Map();
  for (const v of Object.values(cache?.byBarcode || {})) {
    const ean = clean(v.barcode);
    if (ean && !m.has(ean)) m.set(ean, clean(v.title));
  }
  return m;
}

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
  const titles = await titleByEan();
  const offerMap = (await readJsonBlob(OFFER_MAP_PATH, null))?.byEan || {};

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
    drempel: BUYBOX_DREMPEL
  };
  try { await writeJsonBlob(PATH, result); } catch (_) {}
  return result;
}

export async function readBolInsights() { return readJsonBlob(PATH, null); }
export function isInsightsFresh(p) { return p?.refreshedAt && (Date.now() - new Date(p.refreshedAt).getTime()) < MAX_AGE_MS; }

/**
 * Repricing-advies voor één EAN: haalt de concurrerende offers op, bepaalt de
 * buy-box-winnaar en geeft een veilig prijsadvies (matchen/onderbieden tot de
 * bodem = max(85% van onze prijs, …)). Schrijft niets — advies.
 */
export async function getRepriceAdvice(ean) {
  if (!isBolConfigured()) throw new Error('bol niet gekoppeld.');
  const e = clean(ean);
  const offerMap = (await readJsonBlob(OFFER_MAP_PATH, null))?.byEan || {};
  const onzePrijs = num(offerMap[e]?.prijs) || null;

  let raw;
  try { raw = await bolGet(COMPETING_PATH.replace('{ean}', e)); } catch (err) { throw new Error(`Concurrent-offers ophalen mislukt: ${err.message}`); }
  const offers = (raw?.offers || raw?.competingOffers || []).map((o) => ({
    prijs: num(o.price ?? o.bundlePrices?.[0]?.price ?? o.pricing?.bundlePrices?.[0]?.price),
    bestOffer: Boolean(o.bestOffer ?? o.buyBox),
    conditie: clean(o.condition?.name || o.condition),
    levering: clean(o.ultimateDeliveryDate || o.fulfilmentMethod)
  })).filter((o) => o.prijs > 0);

  const winnaar = offers.find((o) => o.bestOffer) || offers.slice().sort((a, b) => a.prijs - b.prijs)[0] || null;
  const buyBoxPrijs = winnaar ? winnaar.prijs : null;
  const bodem = onzePrijs ? Math.round(onzePrijs * PRICE_FLOOR_FACTOR * 100) / 100 : null;

  let advies = null, adviesPrijs = null;
  if (buyBoxPrijs != null) {
    if (onzePrijs && Math.abs(onzePrijs - buyBoxPrijs) < 0.005) advies = 'Je hebt waarschijnlijk al de buy box.';
    else {
      const doel = Math.round((buyBoxPrijs - 0.01) * 100) / 100;
      adviesPrijs = bodem != null ? Math.max(doel, bodem) : doel;
      advies = (bodem != null && adviesPrijs <= bodem)
        ? `Buy-box-prijs (€${buyBoxPrijs.toFixed(2)}) ligt onder je bodem (€${bodem.toFixed(2)}) — niet verlagen, marge beschermen.`
        : `Verlaag naar €${adviesPrijs.toFixed(2)} om de buy box te pakken (buy-box nu €${buyBoxPrijs.toFixed(2)}).`;
    }
  } else advies = 'Geen concurrerende offers gevonden.';

  return { ean: e, onzePrijs, buyBoxPrijs, bodem, adviesPrijs, advies, aantalOffers: offers.length };
}
