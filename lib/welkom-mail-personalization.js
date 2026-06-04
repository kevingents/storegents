/**
 * lib/welkom-mail-personalization.js
 *
 * Per-klant personalisatie voor de welkom-mail:
 *   1. Huidige puntenstand uit SRS (si_spaarpunten) + voortgang naar volgende
 *      voucher (250 = €10 / 500 = €25).
 *   2. Laatste aankopen uit SRS (si_klanten getTransactions) → bepaal de
 *      meest-gekochte hoofdgroep.
 *   3. 4 suggested products uit de Shopify-cache die in dezelfde hoofdgroep
 *      vallen maar NIET in de aankoopgeschiedenis voorkomen.
 *
 * Alles best-effort: bij elke fout returnt de helper een leeg blok zodat het
 * verzenden van de welkom-mail niet vastloopt op personalisatie-issues.
 */

import { getPointsBalance } from './srs-points-client.js';
import { getTransactions } from './srs-customers-client.js';
import { readProductsCache } from './shopify-products-cache.js';

const clean = (v) => String(v == null ? '' : v).trim();

/* Voucher-drempels: spaartrap voor de progress-balk in de mail. */
const VOUCHER_TIERS = [
  { points: 250, value: 10 },
  { points: 500, value: 25 }
];

/* Hoeveel maanden terug kijken voor aankoopgeschiedenis. */
const TRANSACTIONS_LOOKBACK_MONTHS = 12;

/* Hoeveel suggestion-cards in de mail (Spotler-grid = 2x2). */
const SUGGESTED_COUNT = 4;

/* Voor pseudo-random product-selectie (deterministisch per klant). */
function djb2Hash(str) {
  let h = 5381;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) + s.charCodeAt(i);
  return Math.abs(h);
}

/* — Punten + voucher-voortgang ────────────────────────────────────────── */

async function fetchPoints(customerId) {
  try {
    const id = clean(customerId);
    if (!id) return null;
    const result = await getPointsBalance({ customerFrom: id, customerTo: id });
    const bal = result?.balances?.find((b) => clean(b.customerId) === id) || result?.balances?.[0];
    const current = Number(bal?.balance || 0);
    if (!Number.isFinite(current) || current < 0) return null;
    const nextTier = VOUCHER_TIERS.find((t) => current < t.points);
    const progressPct = nextTier ? Math.round((current / nextTier.points) * 100) : 100;
    return {
      current,
      nextTarget: nextTier ? nextTier.points : null,
      nextValue: nextTier ? nextTier.value : null,
      pointsToGo: nextTier ? Math.max(0, nextTier.points - current) : 0,
      progressPct,
      maxTierReached: !nextTier
    };
  } catch (e) {
    console.warn(`[welkom-personalization] points fetch faalde (${customerId}): ${e.message}`);
    return null;
  }
}

/* — Aankoopgeschiedenis ───────────────────────────────────────────────── */

async function fetchRecentPurchases(customerId) {
  try {
    const id = clean(customerId);
    if (!id) return [];
    const from = new Date(Date.now() - TRANSACTIONS_LOOKBACK_MONTHS * 30 * 24 * 3600 * 1000)
      .toISOString().slice(0, 10);
    const until = new Date().toISOString().slice(0, 10);
    const result = await getTransactions({ customerId: id, from, until });
    const txs = Array.isArray(result?.transactions) ? result.transactions
      : Array.isArray(result) ? result : [];
    const items = [];
    for (const t of txs) {
      const itemList = Array.isArray(t?.items) ? t.items : [];
      for (const it of itemList) {
        const sku = clean(it.sku || it.barcode || it.articleNumber);
        if (!sku) continue;
        items.push({
          sku,
          description: clean(it.description || ''),
          pieces: Number(it.pieces || 1),
          date: clean(t.dateTime || t.date || '')
        });
      }
    }
    /* Sorteer recent eerst en dedup op SKU (laatste wint). */
    items.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const seen = new Set(), uniq = [];
    for (const it of items) {
      if (seen.has(it.sku)) continue;
      seen.add(it.sku);
      uniq.push(it);
      if (uniq.length >= 30) break;
    }
    return uniq;
  } catch (e) {
    console.warn(`[welkom-personalization] transactions fetch faalde (${customerId}): ${e.message}`);
    return [];
  }
}

/* — Suggested products op basis van aankoopgeschiedenis ──────────────── */

/* Bepaal welke hoofdgroep de klant het meest koopt. Valt terug op
   productType als hoofdgroep ontbreekt. */
function pickDominantCategory(purchasedVariants) {
  const counts = {};
  for (const v of purchasedVariants) {
    const key = clean(v.hoofdgroep) || clean(v.productType) || '';
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  return sorted[0]?.[0] || '';
}

async function fetchSuggestedProducts(customerId, recentPurchases) {
  try {
    if (!recentPurchases.length) return [];
    const cache = await readProductsCache();
    const productList = Array.isArray(cache?.products) ? cache.products
      : Array.isArray(cache) ? cache : [];
    if (!productList.length) return [];

    /* Match aankopen → product-cache via SKU/barcode/srsRveArtikelnummer. */
    const purchasedVariants = [];
    const purchasedProductIds = new Set();
    const skuSet = new Set(recentPurchases.map((p) => p.sku));
    for (const p of productList) {
      const variants = Array.isArray(p.variants) ? p.variants : [];
      for (const v of variants) {
        const matchSku = skuSet.has(clean(v.sku)) || skuSet.has(clean(v.barcode));
        const matchSrs = skuSet.has(clean(p.srsRveArtikelnummer)) || skuSet.has(clean(p.srsArtikelId));
        if (matchSku || matchSrs) {
          purchasedVariants.push({ ...v, ...p, productId: p.productId });
          purchasedProductIds.add(p.productId);
          break;
        }
      }
    }
    if (!purchasedVariants.length) return [];

    const targetCategory = pickDominantCategory(purchasedVariants);
    if (!targetCategory) return [];

    /* Filter cache: zelfde categorie, niet zelf gekocht, image + price aanwezig. */
    const candidates = productList.filter((p) => {
      if (purchasedProductIds.has(p.productId)) return false;
      const cat = clean(p.hoofdgroep) || clean(p.productType) || '';
      if (cat !== targetCategory) return false;
      const v0 = (p.variants || [])[0];
      if (!v0 || !clean(v0.image) || !v0.price) return false;
      return true;
    });
    if (!candidates.length) return [];

    /* Deterministisch shufflen per klant (zelfde mail = zelfde suggesties). */
    const seed = djb2Hash(customerId);
    const sorted = candidates
      .map((p, i) => ({ p, sortKey: djb2Hash(`${seed}-${p.productId || i}`) }))
      .sort((a, b) => a.sortKey - b.sortKey)
      .slice(0, SUGGESTED_COUNT)
      .map(({ p }) => {
        const v = p.variants[0];
        const handle = clean(p.handle);
        const url = handle ? `https://gents.nl/products/${handle}` : 'https://gents.nl';
        const price = Number(v.price || 0);
        return {
          title: clean(p.title || v.title || 'GENTS'),
          image: clean(v.image),
          price: price > 0 ? `€ ${price.toFixed(2).replace('.', ',')}` : '',
          url
        };
      });
    return sorted;
  } catch (e) {
    console.warn(`[welkom-personalization] suggested products faalde (${customerId}): ${e.message}`);
    return [];
  }
}

/* — Public API ────────────────────────────────────────────────────────── */

/**
 * Verzamel alle personalisatie-data voor 1 klant.
 *
 * @param {Object} customer - SRS-klant uit getCustomers (heeft customerId)
 * @returns {Promise<{points: Object|null, recentPurchases: Array, suggestedProducts: Array}>}
 */
export async function getCustomerPersonalization(customer) {
  const customerId = clean(customer?.customerId || customer?.CustomerId || customer?.id);
  if (!customerId) return { points: null, recentPurchases: [], suggestedProducts: [] };

  /* Parallel SRS-calls (punten + transacties), Shopify-suggesties wachten op tx. */
  const [points, recentPurchases] = await Promise.all([
    fetchPoints(customerId),
    fetchRecentPurchases(customerId)
  ]);
  const suggestedProducts = await fetchSuggestedProducts(customerId, recentPurchases);

  return { points, recentPurchases, suggestedProducts };
}
