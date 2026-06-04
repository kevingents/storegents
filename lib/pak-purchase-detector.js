/**
 * lib/pak-purchase-detector.js
 *
 * Vindt klanten die in een lookback-window een PAK hebben gekocht.
 * Filtert SRS-transactions op items waarvan de hoofdgroep (uit Shopify cache)
 * "Pakken" is. Voor MVP gaat het om winkel-aankopen via SRS — online orders
 * komen via een ander pad (Shopify webhook → eigen pak-detect).
 *
 * Output per match:
 *   { customerId, email, firstName, branchId, sku, orderId, purchaseDate }
 *
 * De detector zelf doet géén deduplicatie tegen sent-blob (dat doet de
 * automation-runner, want die kent de cooldown-config).
 */

import { getCustomers, getTransactions } from './srs-customers-client.js';
import { readProductsCache } from './shopify-products-cache.js';

const clean = (v) => String(v == null ? '' : v).trim();
const cleanEmail = (e) => {
  const s = clean(e).toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
};

/* Hoofdgroep-aliases waarop we matchen. SRS-data en Shopify-categorisering
   variëren licht; allebei dekken we af. */
const PAK_HOOFDGROEPEN = new Set([
  'pakken', 'pak', 'kostuums', 'kostuum', 'suits', 'suit'
]);

function isPakItem(productCacheEntry) {
  if (!productCacheEntry) return false;
  const hoofdgroep = clean(productCacheEntry.hoofdgroep).toLowerCase();
  const productType = clean(productCacheEntry.productType).toLowerCase();
  if (PAK_HOOFDGROEPEN.has(hoofdgroep) || PAK_HOOFDGROEPEN.has(productType)) return true;
  /* Backup: product title bevat 'pak' als woord (niet 'pakket' etc.) */
  const title = clean(productCacheEntry.title).toLowerCase();
  if (/\bpak(ken)?\b/.test(title) && !/(pakket|verpak)/.test(title)) return true;
  return false;
}

/* Bouw een lookup-map van SKU/barcode/srsArtikelnummer → product-cache entry.
   Verzamelt alle relevante velden in 1 object voor snelle isPakItem-checks. */
function buildSkuLookup(cache) {
  const productList = Array.isArray(cache?.products) ? cache.products
    : Array.isArray(cache) ? cache : [];
  const lookup = new Map();
  for (const p of productList) {
    const meta = {
      productId: p.productId,
      title: p.title || '',
      hoofdgroep: p.hoofdgroep || '',
      productType: p.productType || ''
    };
    const variants = Array.isArray(p.variants) ? p.variants : [];
    for (const v of variants) {
      if (v.sku) lookup.set(clean(v.sku), meta);
      if (v.barcode) lookup.set(clean(v.barcode), meta);
    }
    if (p.srsRveArtikelnummer) lookup.set(clean(p.srsRveArtikelnummer), meta);
    if (p.srsArtikelId) lookup.set(clean(p.srsArtikelId), meta);
  }
  return lookup;
}

/**
 * Vind alle klanten die een pak hebben gekocht in [fromDate, untilDate].
 *
 * @param {Object} opts
 * @param {string} opts.fromDate - YYYY-MM-DD
 * @param {string} opts.untilDate - YYYY-MM-DD
 * @returns {Promise<Array<{customerId, email, firstName, branchId, sku, orderId, purchaseDate, productTitle}>>}
 */
export async function findPakBuyers({ fromDate, untilDate } = {}) {
  if (!fromDate || !untilDate) throw new Error('fromDate en untilDate verplicht.');

  /* Stap 1: laad product-cache eenmaal en bouw SKU-lookup. */
  const cache = await readProductsCache();
  const skuLookup = buildSkuLookup(cache);
  if (!skuLookup.size) return [];

  /* Stap 2: SRS-customers met allowMailings=true die in de window iets hebben
     gekocht. Filter daarna per klant op pak-items in hun transacties. */
  let customers = [];
  try {
    customers = await getCustomers({
      updatedFrom: fromDate,
      allowMailings: true
    });
  } catch (e) {
    console.warn(`[pak-detect] getCustomers faalde: ${e.message}`);
    return [];
  }

  const matches = [];
  /* Per klant transacties ophalen en checken op pak-items. Sequentieel ipv
     parallel om SRS niet te overspoelen — er zijn meestal <50 klanten/dag. */
  for (const c of (customers || [])) {
    const customerId = clean(c.customerId || c.CustomerId || c.id);
    if (!customerId) continue;
    const email = cleanEmail(c.email);
    if (!email) continue;
    const opt = clean(c.allowMailings) === 'true' || c.allowMailings === true;
    if (!opt) continue;

    let txResult = null;
    try {
      txResult = await getTransactions({ customerId, from: fromDate, until: untilDate });
    } catch (e) {
      console.warn(`[pak-detect] getTransactions ${customerId} faalde: ${e.message}`);
      continue;
    }

    const txs = Array.isArray(txResult?.transactions) ? txResult.transactions
      : Array.isArray(txResult) ? txResult : [];

    /* Per transactie: zoek het EERSTE pak-item; dat is de trigger. */
    for (const t of txs) {
      const items = Array.isArray(t?.items) ? t.items : [];
      for (const it of items) {
        const sku = clean(it.sku || it.barcode || it.articleNumber);
        if (!sku) continue;
        const product = skuLookup.get(sku);
        if (!product || !isPakItem(product)) continue;
        matches.push({
          customerId,
          email,
          firstName: clean(c.firstName || c.voornaam || ''),
          branchId: clean(t.branchId || ''),
          sku,
          orderId: clean(t.receiptNr || t.id || ''),
          purchaseDate: clean(t.dateTime || t.date || ''),
          productTitle: clean(product.title)
        });
        break; /* 1 pak per transactie is genoeg voor de trigger */
      }
    }
  }

  return matches;
}
