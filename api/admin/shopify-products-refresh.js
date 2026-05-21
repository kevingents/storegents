/**
 * Manual trigger voor de Shopify products-cache refresh.
 *
 *   POST /api/admin/shopify-products-refresh
 *     (admin-token vereist)
 *
 * Voor wanneer de daily cron niet snel genoeg is — bv. na productlancering
 * of als de cache is corrupted/leeg. Bouwt cache opnieuw uit Shopify GraphQL
 * Admin API. Kan 30-60 seconden duren bij veel producten.
 */

import { refreshShopifyProductsCache } from '../../lib/shopify-products-cache.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

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
    console.error('[admin/shopify-products-refresh]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Refresh mislukt.'
    });
  }
}
