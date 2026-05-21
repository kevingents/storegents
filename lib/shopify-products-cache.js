/**
 * Shopify products cache — voor de Artikel-zoeker.
 *
 * Doel: SKU/barcode → { image, title, description, handle, productUrl, color, size }.
 * De artikel-zoeker leest dit zodat de winkel-medewerker product-foto's
 * (uit Shopify) ziet bij elk artikel uit de SRS stock-snapshot.
 *
 * Strategie:
 *   - Snapshot opgeslagen in Blob: shopify-products/cache.json
 *   - Index: per SKU + per barcode → variant-info
 *   - Daily cron ververst de cache (volledige product-fetch via /admin/api/products.json)
 *   - In-memory caching binnen 1 hot Vercel function voor snelle herhaling
 *
 * Schema:
 *   {
 *     refreshedAt: ISO,
 *     productCount: N,
 *     variantCount: M,
 *     bySku:     { "SKU123": { ...variantData } },
 *     byBarcode: { "8718...": { ...variantData } },
 *     bySrsArticleNumber: { "PAC/PS/2P-586861/GRE": { ...variantData } }
 *   }
 *
 * variantData = {
 *   variantId, productId, title, productHandle,
 *   image, images: [url1, url2, ...],
 *   description, descriptionPlain,
 *   color, size, sku, barcode, articleNumber,
 *   price, vendor, productType
 * }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const CACHE_PATH = 'shopify-products/cache.json';
const MAX_AGE_MS = Number(process.env.SHOPIFY_PRODUCTS_MAX_AGE_MS || 24 * 60 * 60 * 1000); /* 24u */

let __MEM_CACHE__ = null;
let __MEM_AT__ = 0;
const MEM_TTL_MS = 5 * 60 * 1000; /* 5 min hot cache binnen function */

function getConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Probeer kleur/maat te extraheren uit Shopify variant options. */
function detectColorSize(option1, option2, option3, productOptions) {
  const opts = [option1, option2, option3].map((v) => String(v || '').trim());
  const names = (productOptions || []).map((o) => String(o.name || '').toLowerCase());
  let color = '';
  let size = '';
  names.forEach((name, i) => {
    const val = opts[i] || '';
    if (!val) return;
    if (name.includes('kleur') || name.includes('color') || name.includes('colour')) color = val;
    else if (name.includes('maat') || name.includes('size')) size = val;
  });
  /* Fallback: gokt op positie 1 = color, 2 = size */
  if (!color && opts[0] && !opts[0].match(/^\d+$/)) color = opts[0];
  if (!size && opts[1] && opts[1].match(/^[\dXSML/]+$/i)) size = opts[1];
  return { color, size };
}

/**
 * Volledige refresh van Shopify-product cache. Voor de cron.
 * Doorloopt /admin/api/products.json gepagineerd via Link-header.
 */
export async function refreshShopifyProductsCache() {
  const cfg = getConfig();
  if (!cfg) throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt.');

  const bySku = {};
  const byBarcode = {};
  const bySrsArticleNumber = {};
  let productCount = 0;
  let variantCount = 0;

  let nextUrl = `https://${cfg.shop}/admin/api/${cfg.version}/products.json?limit=250&fields=id,handle,title,body_html,vendor,product_type,images,image,variants,options`;
  let pages = 0;
  const MAX_PAGES = 200; /* veiligheidsplafond — 200 × 250 = 50k producten */

  while (nextUrl && pages < MAX_PAGES) {
    const resp = await fetch(nextUrl, {
      headers: { 'X-Shopify-Access-Token': cfg.token, Accept: 'application/json' }
    });
    if (!resp.ok) {
      throw new Error(`Shopify products fetch fout ${resp.status}: ${await resp.text().then((t) => t.slice(0, 200))}`);
    }
    const data = await resp.json();
    const products = data.products || [];

    for (const p of products) {
      productCount += 1;
      const productImage = p.image?.src || (p.images?.[0]?.src || '');
      const allImages = (p.images || []).map((img) => img.src).filter(Boolean);
      const description = String(p.body_html || '');
      const descriptionPlain = stripHtml(description).slice(0, 500);

      for (const v of (p.variants || [])) {
        variantCount += 1;
        const { color, size } = detectColorSize(v.option1, v.option2, v.option3, p.options || []);
        /* Per-variant image als ie er is, anders product-main image */
        const variantImage = (p.images || []).find((img) => Array.isArray(img.variant_ids) && img.variant_ids.includes(v.id))?.src;
        const entry = {
          variantId: String(v.id),
          productId: String(p.id),
          title: String(p.title || '').trim(),
          productHandle: String(p.handle || '').trim(),
          productUrl: p.handle ? `https://${cfg.shop}/products/${p.handle}` : '',
          image: variantImage || productImage || '',
          images: allImages,
          description,
          descriptionPlain,
          color: String(color || '').trim(),
          size: String(size || '').trim(),
          sku: String(v.sku || '').trim(),
          barcode: String(v.barcode || '').trim(),
          articleNumber: String(v.sku || '').trim(), /* Shopify heeft geen apart articleNumber */
          price: String(v.price || '').trim(),
          vendor: String(p.vendor || '').trim(),
          productType: String(p.product_type || '').trim()
        };

        if (entry.sku) bySku[entry.sku.toLowerCase()] = entry;
        if (entry.barcode) byBarcode[entry.barcode.toLowerCase()] = entry;
        /* SRS articleNumber kan ook in SKU staan — index 'm zo dat lookup werkt */
        if (entry.sku) bySrsArticleNumber[entry.sku.toLowerCase()] = entry;
      }
    }

    /* Volgende pagina uit Link-header lezen (Shopify cursor-based pagination) */
    const linkHeader = resp.headers.get('Link') || resp.headers.get('link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    nextUrl = nextMatch ? nextMatch[1] : null;
    pages += 1;
  }

  const payload = {
    refreshedAt: new Date().toISOString(),
    productCount,
    variantCount,
    bySku,
    byBarcode,
    bySrsArticleNumber
  };

  await writeJsonBlob(CACHE_PATH, payload);
  __MEM_CACHE__ = payload;
  __MEM_AT__ = Date.now();
  return { productCount, variantCount, pages };
}

/** Lees de cache. Returnt object met index maps. Lege fallback bij geen cache. */
export async function readProductsCache() {
  if (__MEM_CACHE__ && (Date.now() - __MEM_AT__) < MEM_TTL_MS) return __MEM_CACHE__;
  const data = await readJsonBlob(CACHE_PATH, {
    refreshedAt: null,
    productCount: 0,
    variantCount: 0,
    bySku: {},
    byBarcode: {},
    bySrsArticleNumber: {}
  });
  __MEM_CACHE__ = data;
  __MEM_AT__ = Date.now();
  return data;
}

/** Lookup een variant op SKU OF barcode OF SRS-articleNumber. */
export async function lookupProductVariant({ sku, barcode, articleNumber } = {}) {
  const cache = await readProductsCache();
  const tryKey = (val, map) => {
    if (!val) return null;
    return map[String(val).toLowerCase()] || null;
  };
  return tryKey(barcode, cache.byBarcode)
    || tryKey(sku, cache.bySku)
    || tryKey(articleNumber, cache.bySrsArticleNumber)
    || null;
}

/** Bulk lookup — efficiënter dan N x lookupProductVariant in een loop. */
export async function bulkLookupVariants(rows = []) {
  const cache = await readProductsCache();
  return rows.map((r) => {
    const lookup = (val, map) => val ? map[String(val).toLowerCase()] : null;
    return lookup(r.barcode, cache.byBarcode)
      || lookup(r.sku, cache.bySku)
      || lookup(r.articleNumber, cache.bySrsArticleNumber)
      || null;
  });
}

/** Check of cache fresh is. */
export async function isCacheFresh() {
  const cache = await readProductsCache();
  if (!cache.refreshedAt) return false;
  return (Date.now() - new Date(cache.refreshedAt).getTime()) < MAX_AGE_MS;
}
