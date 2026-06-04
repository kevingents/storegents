/**
 * GET /api/admin/shopify-barcode-lookup?barcode=5018746019878
 *
 * Diagnose: zoekt voor 1 barcode op MEERDERE manieren in Shopify zodat we
 * precies kunnen zien wat wel/niet matched:
 *   1. productVariants(query: "barcode:X")  — wat onze fallback gebruikt
 *   2. productVariants(query: "sku:X")      — voor het geval EAN als SKU staat
 *   3. products(query: "barcode:X")         — Shopify product-search (= UI search)
 *   4. products(query: <raw X>)             — vrije tekst search (= UI default)
 *   5. Onze blob-cache                      — wat onze pre-built cache zegt
 *
 * Hiermee zien we direct waar de mismatch zit: Shopify search-UI gebruikt
 * vaak een wijdere search (tags, metafields, beschrijving) dan een GraphQL
 * variant-filter.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';

export const maxDuration = 30;

const clean = (v) => String(v == null ? '' : v).trim();

function getShopifyConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

async function shopifyGraphQL(cfg, query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': cfg.token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal
    });
    const txt = await r.text();
    if (!r.ok) return { error: `HTTP ${r.status}`, body: txt.slice(0, 500) };
    const j = JSON.parse(txt);
    if (j.errors) return { error: 'GraphQL errors', body: j.errors };
    return { data: j.data };
  } catch (e) {
    return { error: e?.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const barcode = clean(req.query.barcode);
  if (!barcode) return res.status(400).json({ success: false, message: 'barcode query-parameter verplicht.' });

  const cfg = getShopifyConfig();
  if (!cfg) return res.status(500).json({ success: false, message: 'SHOPIFY env ontbreekt.' });

  /* 1. Cache-lookup */
  const cache = await readProductsCache().catch(() => null);
  const cacheByBarcode = cache?.byBarcode?.[barcode.toLowerCase()] || null;
  const cacheBySku = cache?.bySku?.[barcode.toLowerCase()] || null;

  /* 2. Live productVariants by barcode */
  const variantsByBarcode = await shopifyGraphQL(cfg, `
    query($q: String!) {
      productVariants(first: 10, query: $q) {
        nodes { id sku barcode title product { id title status handle } }
      }
    }`, { q: `barcode:${barcode}` });

  /* 3. Live productVariants by sku (in case EAN was filed under sku) */
  const variantsBySku = await shopifyGraphQL(cfg, `
    query($q: String!) {
      productVariants(first: 10, query: $q) {
        nodes { id sku barcode title product { id title status handle } }
      }
    }`, { q: `sku:${barcode}` });

  /* 4. Live products by barcode (Shopify UI search-style) */
  const productsByBarcode = await shopifyGraphQL(cfg, `
    query($q: String!) {
      products(first: 5, query: $q) {
        nodes {
          id title status handle
          variants(first: 100) { nodes { id sku barcode title } }
        }
      }
    }`, { q: `barcode:${barcode}` });

  /* 5. Live products vrije tekst (broadst — matches title, tags, metafields, description) */
  const productsByText = await shopifyGraphQL(cfg, `
    query($q: String!) {
      products(first: 5, query: $q) {
        nodes {
          id title status handle
          variants(first: 100) { nodes { id sku barcode title } }
        }
      }
    }`, { q: barcode });

  /* Verzamel alle variants die we vonden ergens en filter op exacte barcode-match */
  const allFoundVariants = [];
  const collect = (label, varList) => {
    for (const v of (varList || [])) {
      const vid = clean(v.id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
      allFoundVariants.push({
        source: label,
        variantId: vid,
        sku: clean(v.sku),
        barcode: clean(v.barcode),
        variantTitle: clean(v.title),
        productTitle: clean(v.product?.title || v._productTitle || ''),
        productStatus: clean(v.product?.status || v._productStatus || ''),
        adminUrl: vid ? `https://${cfg.shop}/admin/products/${clean(v.product?.id || v._productId || '').replace(/^gid:\/\/shopify\/Product\//, '')}/variants/${vid}` : ''
      });
    }
  };
  collect('variantsByBarcode', variantsByBarcode?.data?.productVariants?.nodes);
  collect('variantsBySku', variantsBySku?.data?.productVariants?.nodes);
  for (const p of (productsByBarcode?.data?.products?.nodes || [])) {
    const enriched = (p.variants?.nodes || []).map((v) => ({
      ...v,
      _productTitle: p.title, _productStatus: p.status, _productId: p.id,
      product: { title: p.title, status: p.status, id: p.id }
    }));
    collect('productsByBarcode→variants', enriched);
  }
  for (const p of (productsByText?.data?.products?.nodes || [])) {
    const enriched = (p.variants?.nodes || []).map((v) => ({
      ...v,
      _productTitle: p.title, _productStatus: p.status, _productId: p.id,
      product: { title: p.title, status: p.status, id: p.id }
    }));
    collect('productsByText→variants', enriched);
  }

  /* Welke vond barcode exact (case-insensitive)? */
  const exactBarcodeHits = allFoundVariants.filter((v) => clean(v.barcode).toLowerCase() === barcode.toLowerCase());
  const exactSkuHits = allFoundVariants.filter((v) => clean(v.sku).toLowerCase() === barcode.toLowerCase());

  return res.status(200).json({
    success: true,
    barcode,
    cache: {
      hitByBarcode: cacheByBarcode ? {
        sku: cacheByBarcode.sku,
        barcode: cacheByBarcode.barcode,
        shopifyVariantId: cacheByBarcode.shopifyVariantId,
        productTitle: cacheByBarcode.title
      } : null,
      hitBySku: cacheBySku ? { sku: cacheBySku.sku, barcode: cacheBySku.barcode } : null,
      generatedAt: cache?.generatedAt || null,
      totalBarcodes: Object.keys(cache?.byBarcode || {}).length
    },
    liveShopify: {
      variantsByBarcode_count: variantsByBarcode?.data?.productVariants?.nodes?.length || 0,
      variantsBySku_count: variantsBySku?.data?.productVariants?.nodes?.length || 0,
      productsByBarcode_count: productsByBarcode?.data?.products?.nodes?.length || 0,
      productsByText_count: productsByText?.data?.products?.nodes?.length || 0,
      variantsByBarcode_error: variantsByBarcode?.error || null,
      variantsBySku_error: variantsBySku?.error || null,
      productsByBarcode_error: productsByBarcode?.error || null,
      productsByText_error: productsByText?.error || null,
      exactBarcodeHits,
      exactSkuHits
    },
    diagnose: exactBarcodeHits.length > 0
      ? `${exactBarcodeHits.length} variant(en) met EXACT deze barcode gevonden. Cache zou hem MOETEN hebben — onderzoek waarom cache-build hem mist.`
      : exactSkuHits.length > 0
        ? `${exactSkuHits.length} variant(en) met deze waarde als SKU (niet barcode). Vul de barcode in Shopify in voor automatische matching.`
        : productsByText?.data?.products?.nodes?.length
          ? `Geen variant heeft deze barcode/SKU. Wel een product gevonden via vrije tekst-search — waarschijnlijk staat de barcode in een tag of metafield, niet in het variant.barcode-veld. Vul 'm in op variant-niveau.`
          : `Geen enkele Shopify-call vond iets. Of de barcode is écht niet in Shopify, of de search-syntax matched niet — kijk onder liveShopify.*_error.`
  });
}
