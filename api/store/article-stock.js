import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { realtimeStockForVariants } from '../../lib/shopify-realtime-search.js';

/**
 * POST /api/store/article-stock
 *
 * Realtime stock-lookup voor een lijst Shopify variant-IDs.
 *
 * Gebruikt door de "Voorraad opzoeken" UI: frontend belt eerst
 * /api/store/article-search?withStock=0 voor instant search-resultaten +
 * facets (uit cache), en haalt vervolgens lazy (per zichtbare kaart of
 * batch) de echte realtime stock op via dit endpoint.
 *
 * Body:
 *   {
 *     variantIds: ['gid://shopify/ProductVariant/123', ...],   // max 200
 *     store: 'GENTS Delft'                                      // optional
 *   }
 *
 * Response:
 *   {
 *     success: true,
 *     stocks: {
 *       'gid://shopify/ProductVariant/123': {
 *         branches: [{ branchId, store, pieces, isOwn, type }],
 *         totalPieces: 12,
 *         branchCount: 3,
 *         inventoryFetched: true
 *       },
 *       ...
 *     },
 *     inventoryStatus: { attempted, succeeded, chunksOk, chunksFail, errors }
 *   }
 *
 * Geen admin-token vereist — winkel-medewerkers gebruiken dit ook vanaf POS.
 */

function clean(v) { return String(v || '').trim(); }

const MAX_VARIANTS = 200;

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const ownStore = clean(body.store);
    const rawIds = Array.isArray(body.variantIds) ? body.variantIds : [];

    /* Filter + dedupe + limit. Frontend kan honderden variants meegeven; we
       cappen op MAX_VARIANTS om Shopify-rate-limits niet te overspoelen. */
    const seen = new Set();
    const variantIds = [];
    for (const v of rawIds) {
      const id = clean(v);
      if (!id || seen.has(id)) continue;
      if (!id.startsWith('gid://shopify/ProductVariant/')) continue;
      seen.add(id);
      variantIds.push(id);
      if (variantIds.length >= MAX_VARIANTS) break;
    }

    if (!variantIds.length) {
      return res.status(200).json({
        success: true,
        stocks: {},
        inventoryStatus: { attempted: 0, succeeded: 0, chunksOk: 0, chunksFail: 0 },
        message: 'Geen geldige variant-IDs meegegeven.'
      });
    }

    const startedAt = Date.now();
    const { stocks, inventoryStatus } = await realtimeStockForVariants({ variantIds, ownStore });
    const durationMs = Date.now() - startedAt;

    return res.status(200).json({
      success: true,
      stocks,
      inventoryStatus,
      requested: variantIds.length,
      durationMs,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[store/article-stock]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Stock-lookup mislukt.'
    });
  }
}
