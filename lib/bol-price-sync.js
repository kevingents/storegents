/**
 * lib/bol-price-sync.js
 *
 * Zet de bol-prijs gelijk aan de WEBSHOP-prijs + verzendkosten (pariteit), zodat
 * bol nooit goedkoper is dan gents.nl — we onderbieden niet en concurreren niet
 * met onszelf. Schrijft alleen waar de bol-prijs afwijkt.
 *
 *   bol-prijs = webshop-prijs (Shopify) + BOL_SHIPPING_SURCHARGE
 *
 * Standaard DRY-RUN: toont wat zou wijzigen zonder naar bol te schrijven.
 */

import { bolPost, isBolConfigured } from './bol-client.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { getBolSettings } from './bol-settings-store.js';

const OFFER_MAP_PATH = 'marketplace/bol-offer-map.json';
const PLAN_PATH = 'marketplace/bol-price-plan.json';
const MAX_PUSH = Number(process.env.BOL_PRICE_MAX_PUSH || 1000);
const MAX_AGE_MS = Number(process.env.BOL_PRICE_MAX_AGE_MS || 60 * 60 * 1000);
/* Veiligheid: weiger live-push op een te oude Shopify-cache / offer-map, en
   weiger een verdacht grote prijsdaling (bv. foute/sale-prijs). */
const CACHE_MAX_AGE_MS = Number(process.env.BOL_PRICE_CACHE_MAX_AGE_MS || 48 * 60 * 60 * 1000);
const OFFER_MAP_MAX_AGE_MS = Number(process.env.BOL_PRICE_OFFERMAP_MAX_AGE_MS || 12 * 60 * 60 * 1000);
const MAX_DROP = Number(process.env.BOL_PRICE_MAX_DROP_PCT || 0.25);

const clean = (v) => String(v == null ? '' : v).trim();
const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;

async function webshopByEan() {
  const cache = await readProductsCache().catch(() => null);
  const m = new Map();
  for (const v of Object.values(cache?.byBarcode || {})) {
    const ean = clean(v.barcode);
    if (ean && !m.has(ean)) m.set(ean, { titel: clean(v.title), prijs: num(v.price) || null });
  }
  return m;
}

/** Bouw per EAN de gewenste bol-prijs (= webshop + verzendkosten). */
export async function buildBolPricePlan() {
  const [web, settings] = await Promise.all([webshopByEan(), getBolSettings()]);
  const SURCHARGE = Number(settings.shippingSurcharge) || 0;
  const TOL = Number(settings.parityTolerance) || 0.02;
  const offerMap = (await readJsonBlob(OFFER_MAP_PATH, null))?.byEan || {};
  const items = [];
  let teWijzigen = 0, zonderWebshopPrijs = 0;
  for (const [ean, o] of Object.entries(offerMap)) {
    const bolPrijs = num(o.prijs) || null;
    const webshopPrijs = web.get(ean)?.prijs ?? null;
    if (webshopPrijs == null) { zonderWebshopPrijs += 1; continue; }
    const pariteitPrijs = r2(webshopPrijs + SURCHARGE);
    const wijzigt = bolPrijs == null || Math.abs(bolPrijs - pariteitPrijs) > TOL;
    if (wijzigt) teWijzigen += 1;
    items.push({ ean, titel: web.get(ean)?.titel || '', offerId: o.offerId, bolPrijs, webshopPrijs, pariteitPrijs, wijzigt });
  }
  items.sort((a, b) => (b.wijzigt - a.wijzigt) || (b.pariteitPrijs - a.pariteitPrijs));
  const result = {
    refreshedAt: new Date().toISOString(),
    principe: 'bol-prijs = webshop-prijs + verzendkosten (geen onderbieding)',
    verzendkosten: SURCHARGE,
    /* Waarschuwing: zonder verzendmarge wordt bol exact gelijk aan de webshop
       (niet goedkoper, maar ook geen dekking van bol-commissie/verzending). */
    verzendkostenNul: SURCHARGE <= 0,
    totaal: items.length,
    teWijzigen,
    zonderWebshopPrijs,
    items: items.slice(0, 3000)
  };
  try { await writeJsonBlob(PLAN_PATH, result); } catch (_) {}
  return result;
}

export async function readBolPricePlan() { return readJsonBlob(PLAN_PATH, null); }
export function isPricePlanFresh(p) { return p?.refreshedAt && (Date.now() - new Date(p.refreshedAt).getTime()) < MAX_AGE_MS; }

/**
 * Synchroniseer de bol-prijs met de webshop-pariteit.
 * @param {{dryRun?:boolean, onlyChanged?:boolean}} opts  dryRun standaard true.
 */
export async function runBolPriceSync({ dryRun = true, onlyChanged = true, force = false } = {}) {
  const plan = await buildBolPricePlan();

  if (dryRun) {
    const voorbeeld = plan.items.filter((i) => i.wijzigt).slice(0, 200);
    return { dryRun: true, principe: plan.principe, verzendkosten: plan.verzendkosten, totaal: plan.totaal, teWijzigen: plan.teWijzigen, voorbeeld };
  }

  if (!isBolConfigured()) throw new Error('bol niet gekoppeld — kan prijzen niet syncen.');
  const mapBlob = await readJsonBlob(OFFER_MAP_PATH, null);

  /* ── Veiligheidsguards vóór een live prijs-push ──────────────────────────
     De pariteit leunt op de Shopify-prijscache; en "wijzigt" wordt bepaald t.o.v.
     de bol-prijs uit de offer-map. Zijn die oud, dan zet je mogelijk een foute
     prijs of mis je een handmatig verlaagde bol-offer. Te overrulen met force. */
  if (!force) {
    const cache = await readProductsCache().catch(() => null);
    const cacheAge = cache?.refreshedAt ? Date.now() - new Date(cache.refreshedAt).getTime() : Infinity;
    if (!cache || cacheAge > CACHE_MAX_AGE_MS) {
      return { dryRun: false, ok: false, aborted: true, reason: 'Shopify-prijscache ontbreekt of is te oud — prijs-sync afgebroken. Ververs de productcache eerst (force om te forceren).' };
    }
    const mapAge = mapBlob?.refreshedAt ? Date.now() - new Date(mapBlob.refreshedAt).getTime() : Infinity;
    if (!mapBlob || mapAge > OFFER_MAP_MAX_AGE_MS) {
      return { dryRun: false, ok: false, aborted: true, reason: 'bol offer-map ontbreekt of is verouderd — een handmatig verlaagde bol-prijs zou gemist worden. Ververs de offer-map (Voorraad-sync) eerst (force om te forceren).' };
    }
  }

  const byEan = mapBlob?.byEan || {};
  let gepusht = 0, overgeslagen = 0, fouten = 0, verdacht = 0;
  const resultaten = [];
  for (const it of plan.items) {
    if (!it.offerId) { overgeslagen += 1; continue; }
    if (onlyChanged && !it.wijzigt) { overgeslagen += 1; continue; }
    if (!(it.pariteitPrijs > 0)) { overgeslagen += 1; continue; } /* nooit 0/negatief pushen */
    /* Ondergrens-sanity: weiger een verdacht grote prijsdaling (bv. foute/sale
       Shopify-prijs of verkeerde variant) — niet blind live zetten. */
    if (!force && it.bolPrijs > 0 && it.pariteitPrijs < it.bolPrijs * (1 - MAX_DROP)) {
      verdacht += 1;
      if (resultaten.length < 200) resultaten.push({ ean: it.ean, van: it.bolPrijs, naar: it.pariteitPrijs, geweigerd: `>${Math.round(MAX_DROP * 100)}% daling — handmatig bevestigen` });
      continue;
    }
    if (gepusht >= MAX_PUSH) break;
    try {
      await bolPost(`/offers/${it.offerId}/price`, { pricing: { bundlePrices: [{ quantity: 1, unitPrice: it.pariteitPrijs }] } }, { method: 'PUT' });
      gepusht += 1;
      if (byEan[it.ean]) byEan[it.ean].prijs = it.pariteitPrijs;
      if (resultaten.length < 200) resultaten.push({ ean: it.ean, van: it.bolPrijs, naar: it.pariteitPrijs });
    } catch (e) {
      fouten += 1;
      if (resultaten.length < 200) resultaten.push({ ean: it.ean, error: e.message });
    }
  }
  try { if (mapBlob) await writeJsonBlob(OFFER_MAP_PATH, { ...mapBlob, byEan }); } catch (_) {}

  return { dryRun: false, ok: true, principe: plan.principe, totaal: plan.totaal, gepusht, overgeslagen, fouten, verdacht, resultaten };
}
