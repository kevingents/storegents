/**
 * Shopify products cache — voor de Artikel-zoeker.
 *
 * Doel: koppel SRS stock-rows aan Shopify product-data zodat de winkel
 * medewerker product-foto's + omschrijvingen + categorisatie ziet.
 *
 * Strategie (v2 — met metafields):
 *   - GraphQL Admin API (één call per pagina haalt producten + varianten +
 *     metafields tegelijk op). Veel sneller dan REST + per-product metafield-fetch.
 *   - SRSERP-metafields per product worden geïndexeerd zodat zoeken op
 *     artikel_id / rve_artikelnummer / subgroep / hoofdgroep_omschrijving werkt.
 *   - Cache in Blob: shopify-products/cache.json
 *   - Daily cron ververst (recommended schedule: 0 3 * * *)
 *   - In-memory hot cache binnen één Vercel function: 5 min
 *
 * Schema:
 *   {
 *     refreshedAt: ISO,
 *     productCount, variantCount,
 *     bySku:                { 'sku123': variantData },
 *     byBarcode:            { '8718...': variantData },
 *     bySrsArticleNumber:   { 'PAC/PS/2P-586861/GRE': variantData },
 *     bySrsArtikelId:       { '12345': variantData },          // SRSERP.artikel_id
 *     bySrsRveArtikelnummer:{ 'RVE-99887': variantData }       // SRSERP.rve_artikelnummer
 *   }
 *
 * variantData (alles trimmed strings, behalve images = array):
 *   {
 *     variantId, productId, title, productHandle, productUrl,
 *     image, images: [url],
 *     description, descriptionPlain,
 *     color, size, sku, barcode, articleNumber,
 *     price, vendor, productType,
 *     // SRS-metafields uit Shopify product (geërfd door alle varianten):
 *     srsArtikelId, srsRveArtikelnummer, subgroep, hoofdgroep, hoofdgroepOmschrijving
 *   }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const CACHE_PATH = 'shopify-products/cache.json';
const MAX_AGE_MS = Number(process.env.SHOPIFY_PRODUCTS_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const SRS_METAFIELD_NAMESPACE = process.env.SHOPIFY_SRS_METAFIELD_NS || 'SRSERP';

let __MEM_CACHE__ = null;
let __MEM_AT__ = 0;
const MEM_TTL_MS = 5 * 60 * 1000;

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

function clean(v) { return String(v == null ? '' : v).trim(); }

function detectColorSize(selectedOptions, productOptions) {
  /* selectedOptions = [{name, value}], productOptions = [{name, values}] */
  let color = '';
  let size = '';
  for (const opt of (selectedOptions || [])) {
    const name = String(opt.name || '').toLowerCase();
    const val = String(opt.value || '').trim();
    if (!val) continue;
    if (name.includes('kleur') || name.includes('color') || name.includes('colour')) color = val;
    else if (name.includes('maat') || name.includes('size')) size = val;
  }
  /* Fallback obv positie */
  if (!color || !size) {
    const opts = (selectedOptions || []).map((o) => String(o.value || '').trim());
    if (!color && opts[0] && !/^\d+$/.test(opts[0])) color = opts[0];
    if (!size && opts[1] && /^[\dXSML/]+$/i.test(opts[1])) size = opts[1];
  }
  return { color, size };
}

function metafieldMapFromEdges(edges) {
  /* edges = [{ node: { namespace, key, value } }]
     Sinds we metafields zonder namespace-filter ophalen kunnen er
     duplicates zijn (verschillende namespaces, zelfde key). Strategie:
     SRSERP-namespace heeft prioriteit voor bekende keys. Andere namespaces
     overschrijven niet — eerste-met-naam-wint logica, en SRSERP wint
     altijd. Return shape blijft { key: value } voor backwards compat. */
  const m = {};
  const SRS_NS = (process.env.SHOPIFY_SRS_METAFIELD_NS || 'SRSERP').toLowerCase();
  /* Twee passes: eerst SRSERP, dan rest (vult ontbrekende keys aan). */
  for (const e of (edges || [])) {
    if (String(e?.node?.namespace || '').toLowerCase() !== SRS_NS) continue;
    const k = String(e?.node?.key || '').trim();
    const v = String(e?.node?.value || '').trim();
    if (k && v) m[k] = v;
  }
  for (const e of (edges || [])) {
    if (String(e?.node?.namespace || '').toLowerCase() === SRS_NS) continue;
    const k = String(e?.node?.key || '').trim();
    const v = String(e?.node?.value || '').trim();
    if (!k || !v) continue;
    /* Geen overschrijven van SRSERP-keys */
    if (m[k]) continue;
    m[k] = v;
  }
  return m;
}

/**
 * GraphQL pagination loop — haalt alle producten op met SRSERP metafields.
 */
async function fetchAllProductsViaGraphQL(cfg) {
  const QUERY = `
    query Products($cursor: String) {
      products(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        edges {
          node {
            id
            createdAt
            title
            handle
            bodyHtml
            vendor
            productType
            featuredImage { url }
            images(first: 10) { edges { node { url } } }
            options { name values }
            metafields(first: 50) {
              edges { node { namespace key value } }
            }
            variants(first: 100) {
              edges {
                node {
                  id
                  sku
                  barcode
                  price
                  selectedOptions { name value }
                  image { url }
                }
              }
            }
          }
        }
      }
    }`;

  const products = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 500; /* veiligheidsplafond — 500 × 100 = 50k */

  while (pages < MAX_PAGES) {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': cfg.token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query: QUERY, variables: { cursor } })
    });
    if (!resp.ok) {
      throw new Error(`Shopify GraphQL fout ${resp.status}: ${await resp.text().then((t) => t.slice(0, 300))}`);
    }
    const json = await resp.json();
    if (json.errors) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
    }
    const conn = json.data?.products;
    if (!conn) break;
    for (const edge of (conn.edges || [])) products.push(edge.node);
    pages += 1;
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }

  return { products, pages };
}

/**
 * Build variant-data uit één Shopify product. Metafields worden geërfd door
 * elke variant zodat lookup op artikel_id of rve_artikelnummer direct werkt.
 */
function buildVariantsFromProduct(product, shop) {
  const productMetafields = metafieldMapFromEdges(product?.metafields?.edges);
  const description = String(product?.bodyHtml || '');
  const descriptionPlain = stripHtml(description).slice(0, 500);
  const allImages = (product?.images?.edges || []).map((e) => e?.node?.url).filter(Boolean);
  const featuredImage = product?.featuredImage?.url || allImages[0] || '';
  const productHandle = clean(product?.handle);
  const productUrl = productHandle ? `https://${shop}/products/${productHandle}` : '';

  /* SRSERP metafields — keys volgens user-specs */
  const srsArtikelId        = clean(productMetafields['artikel_id']);
  const srsRveArtikelnummer = clean(productMetafields['rve_artikelnummer']);
  const subgroep            = clean(productMetafields['subgroep']);
  const hoofdgroep          = clean(productMetafields['hoofdgroep']);
  const hoofdgroepOmschr    = clean(productMetafields['hoofdgroep_omschrijving']);
  const jaar                = clean(productMetafields['jaar']);
  const seizoen             = clean(productMetafields['seizoen']);
  /* Content-kwaliteit signalen (presence-only, houdt cache klein) */
  const hasLongDescription  = Boolean(clean(productMetafields['long_description']));
  const hasComplementary    = Boolean(clean(productMetafields['complementary_products']));
  const createdAt           = clean(product?.createdAt);

  /* Verzamel ALLE numerieke metafield-values voor wide-matching (bv. POS
     "Artikel nummer" / "Product identifier ID" die niet noodzakelijk onder
     een bekende key staan). Filter op puur-numeriek (3+ digits) zodat we
     geen labels/teksten meematchen. */
  const numericMetafields = [];
  for (const [key, val] of Object.entries(productMetafields)) {
    if (!val) continue;
    const trimmed = String(val).trim();
    if (/^\d{3,12}$/.test(trimmed)) {
      numericMetafields.push(trimmed);
    }
  }

  const variants = [];
  for (const ve of (product?.variants?.edges || [])) {
    const v = ve.node;
    const { color, size } = detectColorSize(v.selectedOptions, product.options);
    const variantImage = v.image?.url || featuredImage;

    variants.push({
      variantId:         clean(v?.id),
      productId:         clean(product?.id),
      title:             clean(product?.title),
      productHandle,
      productUrl,
      image:             variantImage,
      images:            allImages,
      description,
      descriptionPlain,
      color,
      size,
      sku:               clean(v?.sku),
      barcode:           clean(v?.barcode),
      articleNumber:     clean(v?.sku),
      price:             clean(v?.price),
      vendor:            clean(product?.vendor),
      productType:       clean(product?.productType),
      /* SRSERP metafields (product-level, gedeeld door varianten) */
      srsArtikelId,
      srsRveArtikelnummer,
      subgroep,
      hoofdgroep,
      hoofdgroepOmschrijving: hoofdgroepOmschr,
      jaar,
      seizoen,
      createdAt,
      hasLongDescription,
      hasComplementary,
      /* Alle puur-numerieke metafield-values (bv. 'Artikel nummer'-veld dat
         niet onder onze bekende keys staat). Gebruikt voor wide-match in
         article-search wanneer gebruiker een POS-code intypt. */
      numericMetafields
    });
  }
  return variants;
}

/**
 * Volledige refresh van Shopify-product cache via GraphQL.
 */
export async function refreshShopifyProductsCache() {
  const cfg = getConfig();
  if (!cfg) throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt.');

  const { products, pages } = await fetchAllProductsViaGraphQL(cfg);

  const bySku = {};
  const byBarcode = {};
  const bySrsArticleNumber = {};
  const bySrsArtikelId = {};
  const bySrsRveArtikelnummer = {};
  /* Wide-lookup: elke numerieke metafield-value (en zijn stripped variant)
     wijst naar de bijbehorende variant. Vangt "Artikel nummer = 2039"-velden
     die niet onder een vaste key staan. */
  const byNumericMetafield = {};
  let productCount = 0;
  let variantCount = 0;

  for (const product of products) {
    productCount += 1;
    const variants = buildVariantsFromProduct(product, cfg.shop);
    for (const entry of variants) {
      variantCount += 1;
      if (entry.sku)                bySku[entry.sku.toLowerCase()] = entry;
      if (entry.barcode)            byBarcode[entry.barcode.toLowerCase()] = entry;
      if (entry.sku)                bySrsArticleNumber[entry.sku.toLowerCase()] = entry;
      if (entry.srsArtikelId)       bySrsArtikelId[entry.srsArtikelId.toLowerCase()] = entry;
      if (entry.srsRveArtikelnummer) bySrsRveArtikelnummer[entry.srsRveArtikelnummer.toLowerCase()] = entry;
      /* Numerieke metafields → wide-lookup map (raw + stripped). Eerste-wint
         als meerdere producten dezelfde numerieke value hebben — accept. */
      for (const v of (entry.numericMetafields || [])) {
        const raw = v.toLowerCase();
        const stripped = raw.replace(/^0+(?=\d)/, '');
        if (!byNumericMetafield[raw]) byNumericMetafield[raw] = entry;
        if (stripped !== raw && !byNumericMetafield[stripped]) byNumericMetafield[stripped] = entry;
      }
    }
  }

  const payload = {
    refreshedAt: new Date().toISOString(),
    productCount,
    variantCount,
    bySku,
    byBarcode,
    bySrsArticleNumber,
    bySrsArtikelId,
    bySrsRveArtikelnummer,
    byNumericMetafield
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
    bySrsArticleNumber: {},
    bySrsArtikelId: {},
    bySrsRveArtikelnummer: {}
  });
  /* Defensief: oude cache zonder metafield-indexes hydrateren */
  data.bySrsArtikelId       = data.bySrsArtikelId || {};
  data.bySrsRveArtikelnummer = data.bySrsRveArtikelnummer || {};
  __MEM_CACHE__ = data;
  __MEM_AT__ = Date.now();
  return data;
}

/** Lookup een variant op alle bekende identifiers. */
export async function lookupProductVariant({ sku, barcode, articleNumber, srsArtikelId, srsRveArtikelnummer } = {}) {
  const cache = await readProductsCache();
  const tryKey = (val, map) => {
    if (!val) return null;
    return map[String(val).toLowerCase()] || null;
  };
  return tryKey(barcode, cache.byBarcode)
    || tryKey(sku, cache.bySku)
    || tryKey(articleNumber, cache.bySrsArticleNumber)
    || tryKey(srsArtikelId, cache.bySrsArtikelId)
    || tryKey(srsRveArtikelnummer, cache.bySrsRveArtikelnummer)
    || null;
}

/** Bulk lookup. */
export async function bulkLookupVariants(rows = []) {
  const cache = await readProductsCache();
  return rows.map((r) => {
    const lookup = (val, map) => val ? map[String(val).toLowerCase()] : null;
    return lookup(r.barcode, cache.byBarcode)
      || lookup(r.sku, cache.bySku)
      || lookup(r.articleNumber, cache.bySrsArticleNumber)
      || lookup(r.srsArtikelId, cache.bySrsArtikelId)
      || lookup(r.srsRveArtikelnummer, cache.bySrsRveArtikelnummer)
      || null;
  });
}

/** Check of cache fresh is. */
export async function isCacheFresh() {
  const cache = await readProductsCache();
  if (!cache.refreshedAt) return false;
  return (Date.now() - new Date(cache.refreshedAt).getTime()) < MAX_AGE_MS;
}
