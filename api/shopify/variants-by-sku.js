import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function envFirst(names = []) {
  for (const name of names) {
    const value = process.env[name];
    if (value) return String(value).trim();
  }
  return '';
}

function normalizeShopDomain(value) {
  return String(value || '').trim().replace(/^https?:\/\//, '').replace(/\/admin.*$/i, '').replace(/\/$/, '');
}

function getShopifyConfig() {
  const shop = normalizeShopDomain(envFirst(['SHOPIFY_SHOP_DOMAIN', 'SHOPIFY_STORE_DOMAIN', 'SHOPIFY_STORE_URL', 'SHOPIFY_SHOP', 'SHOP_DOMAIN']));
  const token = envFirst(['SHOPIFY_ADMIN_ACCESS_TOKEN', 'SHOPIFY_ACCESS_TOKEN', 'SHOPIFY_ADMIN_TOKEN']);
  const apiVersion = envFirst(['SHOPIFY_API_VERSION']) || '2024-10';
  if (!shop || !token) throw new Error('Shopify config ontbreekt (SHOPIFY_SHOP_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN niet gezet).');
  return { shop, token, apiVersion };
}

async function shopifyGraphql(query, variables = {}) {
  const { shop, token, apiVersion } = getShopifyConfig();
  const response = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token
    },
    body: JSON.stringify({ query, variables })
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Shopify GraphQL gaf geen JSON: ' + text.slice(0, 200)); }
  if (!response.ok || data.errors) {
    throw new Error('Shopify GraphQL fout: ' + JSON.stringify(data.errors || text).slice(0, 300));
  }
  return data.data || {};
}

/* Simpel in-memory cache zodat herhaalde rendering dezelfde SKU's
   binnen 10 min niet steeds opnieuw fetcht. */
const VARIANT_CACHE = new Map();
const CACHE_TTL_MS = 10 * 60 * 1000;
function cacheGet(sku) {
  const entry = VARIANT_CACHE.get(sku);
  if (!entry || Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    if (entry) VARIANT_CACHE.delete(sku);
    return null;
  }
  return entry.value;
}
function cacheSet(sku, value) {
  VARIANT_CACHE.set(sku, { value, cachedAt: Date.now() });
}

const VARIANT_QUERY = `
  query VariantsBySku($q: String!) {
    productVariants(first: 100, query: $q) {
      nodes {
        id
        sku
        barcode
        title
        price
        image { url altText }
        product {
          id
          title
          handle
          featuredImage { url altText }
        }
      }
    }
  }
`;

/**
 * GET /api/shopify/variants-by-sku?skus=A,B,C
 * Returnt { success, byKey: { sku: {title, image, barcode, variantTitle, productHandle, price} } }
 * Lookup gaat per chunk van 20 SKUs via één GraphQL call (sku:A OR sku:B).
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Alleen GET is toegestaan.' });
  }

  const rawSkus = String(req.query.skus || '');
  const skus = rawSkus
    .split(',')
    .map((s) => String(s || '').trim())
    .filter(Boolean);

  if (!skus.length) {
    return res.status(400).json({ success: false, error: 'Geef minimaal één sku op via ?skus=A,B,C' });
  }

  const byKey = {};
  const toFetch = [];

  for (const sku of skus) {
    const cached = cacheGet(sku);
    if (cached) byKey[sku] = cached;
    else toFetch.push(sku);
  }

  /* Chunk per 20 SKU's in OR-query. Shopify search-syntax: sku:A OR sku:B.
     Quote SKUs met spaties/specials. */
  const CHUNK = 20;
  const chunks = [];
  for (let i = 0; i < toFetch.length; i += CHUNK) chunks.push(toFetch.slice(i, i + CHUNK));

  try {
    for (const chunk of chunks) {
      const q = chunk.map((s) => `sku:${JSON.stringify(s)}`).join(' OR ');
      const data = await shopifyGraphql(VARIANT_QUERY, { q });
      const nodes = data?.productVariants?.nodes || [];
      for (const node of nodes) {
        const sku = String(node.sku || '').trim();
        if (!sku) continue;
        const value = {
          sku,
          barcode: node.barcode || '',
          variantTitle: node.title || '',
          productTitle: node.product?.title || '',
          productHandle: node.product?.handle || '',
          image: node.image?.url || node.product?.featuredImage?.url || '',
          price: node.price || ''
        };
        cacheSet(sku, value);
        if (!byKey[sku]) byKey[sku] = value;
      }
    }

    return res.status(200).json({
      success: true,
      count: Object.keys(byKey).length,
      requested: skus.length,
      byKey
    });
  } catch (error) {
    console.error('[shopify/variants-by-sku]', error);
    return res.status(500).json({ success: false, error: error.message || 'Variant lookup mislukt.' });
  }
}
