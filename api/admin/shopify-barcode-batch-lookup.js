/**
 * GET /api/admin/shopify-barcode-batch-lookup?barcodes=A,B,C,D
 *
 * Batch-diagnose voor meerdere barcodes tegelijk. Returnt per barcode een
 * compacte status + de exacte hit-paden (cache, variant-search, product-search,
 * vrije-tekst-search) zodat we direct zien WAAR de mismatch zit.
 *
 * Drie veelvoorkomende scenarios die we onderscheiden:
 *   A) "cache-stale"      — cache heeft 'm niet, maar live wel → cron-refresh nodig
 *   B) "barcode-als-sku"  — staat als SKU ipv barcode in Shopify
 *   C) "alleen-vrije-tekst" — gevonden in title/tags/metafields, niet als variant.barcode
 *   D) "echt-niet-in-shopify" — geen enkele lookup geeft hit
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';

export const maxDuration = 60;

const clean = (v) => String(v == null ? '' : v).trim();

function getShopifyConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

async function gql(cfg, query, variables) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
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
    if (!r.ok) return { error: `HTTP ${r.status}` };
    const j = await r.json().catch(() => ({}));
    if (j.errors) return { error: 'GraphQL errors', details: j.errors };
    return { data: j.data };
  } catch (e) {
    return { error: e?.name === 'AbortError' ? 'timeout' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

async function diagnoseOne(cfg, cache, barcode) {
  const target = clean(barcode);
  const targetLower = target.toLowerCase();

  /* 1. Cache lookup */
  const cacheHit = cache?.byBarcode?.[targetLower] || null;
  const cacheSku = cache?.bySku?.[targetLower] || null;

  /* 2. productVariants by barcode */
  const vbq = await gql(cfg, `query($q:String!){productVariants(first:10,query:$q){nodes{id sku barcode product{id title status}}}}`, { q: `barcode:${target}` });
  const variantsByBarcode = vbq.data?.productVariants?.nodes || [];
  const exactByBarcode = variantsByBarcode.filter((n) => clean(n.barcode).toLowerCase() === targetLower);

  /* 3. productVariants by sku */
  const vsq = await gql(cfg, `query($q:String!){productVariants(first:10,query:$q){nodes{id sku barcode product{id title status}}}}`, { q: `sku:${target}` });
  const variantsBySku = vsq.data?.productVariants?.nodes || [];
  const exactBySku = variantsBySku.filter((n) => clean(n.sku).toLowerCase() === targetLower);

  /* 4. products by barcode (UI-style) */
  const pbq = await gql(cfg, `query($q:String!){products(first:5,query:$q){nodes{id title status handle variants(first:50){nodes{id sku barcode}}}}}`, { q: `barcode:${target}` });
  const productsByBarcode = pbq.data?.products?.nodes || [];

  /* 5. products vrije tekst */
  const ptq = await gql(cfg, `query($q:String!){products(first:5,query:$q){nodes{id title status handle variants(first:50){nodes{id sku barcode}}}}}`, { q: target });
  const productsByText = ptq.data?.products?.nodes || [];

  /* Verzamel ALLE exacte barcode-matches uit alle paden (na deduplicatie op variantId) */
  const variantMap = new Map();
  const addVariant = (source, v, p) => {
    const variantId = clean(v.id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
    if (!variantId) return;
    if (!variantMap.has(variantId)) {
      variantMap.set(variantId, {
        variantId,
        sku: clean(v.sku),
        barcode: clean(v.barcode),
        productTitle: clean((p || v.product || {}).title || ''),
        productStatus: clean((p || v.product || {}).status || ''),
        productId: clean((p || v.product || {}).id || '').replace(/^gid:\/\/shopify\/Product\//, ''),
        productHandle: clean((p || v.product || {}).handle || ''),
        sources: []
      });
    }
    variantMap.get(variantId).sources.push(source);
  };

  for (const v of exactByBarcode) addVariant('variantsByBarcode', v);
  for (const v of exactBySku) addVariant('variantsBySku', v);
  for (const p of productsByBarcode) {
    for (const v of (p.variants?.nodes || [])) {
      if (clean(v.barcode).toLowerCase() === targetLower) addVariant('productsByBarcode→exactBarcode', v, p);
    }
  }
  for (const p of productsByText) {
    for (const v of (p.variants?.nodes || [])) {
      if (clean(v.barcode).toLowerCase() === targetLower) addVariant('productsByText→exactBarcode', v, p);
      else if (clean(v.sku).toLowerCase() === targetLower) addVariant('productsByText→sameSku', v, p);
    }
  }

  const exactBarcodeHits = [...variantMap.values()].filter((x) => x.barcode.toLowerCase() === targetLower);
  const exactSkuHits = [...variantMap.values()].filter((x) => x.sku.toLowerCase() === targetLower && x.barcode.toLowerCase() !== targetLower);

  /* Diagnose-classificatie */
  let verdict;
  let advice;
  if (cacheHit && exactBarcodeHits.length) {
    verdict = 'cache-ok';
    advice = 'Zit in cache. Match werkt. Geen actie nodig.';
  } else if (!cacheHit && exactBarcodeHits.length) {
    verdict = 'cache-stale';
    advice = 'Shopify heeft het wel als variant.barcode maar cache mist het. Draai /api/cron/shopify-products-refresh om bij te werken.';
  } else if (exactSkuHits.length) {
    verdict = 'barcode-als-sku';
    advice = 'Staat in Shopify als SKU i.p.v. barcode. Vul barcode-veld in Shopify in, anders blijft live-fallback nodig.';
  } else if (productsByBarcode.length || productsByText.length) {
    verdict = 'alleen-product-search';
    advice = 'Wel een product gevonden via product-search (UI-style) maar geen variant heeft EXACT deze barcode. Waarschijnlijk staat de EAN in een metafield/tag/title, niet in variant.barcode. Vul de barcode op variant-niveau in.';
  } else {
    verdict = 'echt-niet-in-shopify';
    advice = 'Geen enkele Shopify-search geeft een hit. Of het product bestaat echt niet, of de EAN matched op geen enkele plek (variant.barcode/sku/title/tag/metafield).';
  }

  return {
    barcode: target,
    verdict,
    advice,
    cache: {
      hitByBarcode: !!cacheHit,
      hitBySku: !!cacheSku,
      cacheGeneratedAt: cache?.generatedAt || null
    },
    counts: {
      variantsByBarcode_total: variantsByBarcode.length,
      variantsByBarcode_exact: exactByBarcode.length,
      variantsBySku_total: variantsBySku.length,
      variantsBySku_exact: exactBySku.length,
      productsByBarcode: productsByBarcode.length,
      productsByText: productsByText.length
    },
    errors: {
      variantsByBarcode: vbq.error || null,
      variantsBySku: vsq.error || null,
      productsByBarcode: pbq.error || null,
      productsByText: ptq.error || null
    },
    exactBarcodeHits: exactBarcodeHits.map((h) => ({
      ...h,
      adminUrl: h.productId ? `https://${cfg.shop}/admin/products/${h.productId}/variants/${h.variantId}` : ''
    })),
    exactSkuHits: exactSkuHits.map((h) => ({
      ...h,
      adminUrl: h.productId ? `https://${cfg.shop}/admin/products/${h.productId}/variants/${h.variantId}` : ''
    })),
    productSearchSamples: productsByText.slice(0, 3).map((p) => ({
      title: p.title,
      status: p.status,
      handle: p.handle,
      variantCount: p.variants?.nodes?.length || 0,
      adminUrl: `https://${cfg.shop}/admin/products/${clean(p.id).replace(/^gid:\/\/shopify\/Product\//, '')}`
    }))
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const raw = clean(req.query.barcodes || '');
  if (!raw) return res.status(400).json({ success: false, message: 'barcodes query-parameter verplicht (komma-gescheiden).' });
  const barcodes = raw.split(',').map(clean).filter(Boolean).slice(0, 20);
  if (!barcodes.length) return res.status(400).json({ success: false, message: 'Geen geldige barcodes meegegeven.' });

  const cfg = getShopifyConfig();
  if (!cfg) return res.status(500).json({ success: false, message: 'SHOPIFY env ontbreekt.' });

  const cache = await readProductsCache().catch(() => null);
  if (!cache) {
    return res.status(500).json({ success: false, message: 'Shopify products-cache leeg — draai /api/cron/shopify-products-refresh.' });
  }

  const results = [];
  for (const bc of barcodes) {
    const r = await diagnoseOne(cfg, cache, bc);
    results.push(r);
  }

  /* Samenvatting */
  const summary = results.reduce((acc, r) => {
    acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});

  return res.status(200).json({
    success: true,
    cacheGeneratedAt: cache.generatedAt || null,
    cacheBarcodeCount: Object.keys(cache.byBarcode || {}).length,
    requestedCount: barcodes.length,
    summary,
    results
  });
}
