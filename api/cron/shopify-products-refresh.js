import { trackedCron } from '../../lib/cron-auto-track.js';
import { refreshShopifyProductsCache } from '../../lib/shopify-products-cache.js';

/**
 * Cron: ververs de Shopify products cache 1× per dag.
 *
 * Voor de Artikel-zoeker — joint SRS stock-snapshot met Shopify product-foto's
 * en omschrijvingen. De cache ligt in Blob shopify-products/cache.json.
 *
 * Vercel cron schedule (suggestie):  0 3 * * *   (03:00 elke nacht)
 */
async function handler(req, res) {
  /* Vercel stuurt bij een cron-invocatie automatisch Authorization: Bearer
     <CRON_SECRET> mee. Daarop vertrouwen we — NIET op de spoofbare vercel-cron
     user-agent. Custom SHOPIFY_PRODUCTS_CRON_SECRET blijft werken voor
     handmatig triggeren. Zonder secret: geen auth-gate (legacy gedrag). */
  const secret = String(process.env.SHOPIFY_PRODUCTS_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const incoming = String(req.headers.authorization || req.query.secret || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    const result = await refreshShopifyProductsCache();
    return res.status(200).json({
      success: true,
      refreshedAt: new Date().toISOString(),
      productCount: result.productCount,
      variantCount: result.variantCount,
      pages: result.pages
    });
  } catch (error) {
    console.error('[shopify-products-refresh]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Refresh mislukt.'
    });
  }
}

export default trackedCron('shopify-products-refresh', handler);
