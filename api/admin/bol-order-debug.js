/**
 * GET /api/admin/bol-order-debug
 *   ?orderId=XXX           → debug 1 specifieke order
 *   ?limit=5               → debug eerste N orders uit cache (default 3)
 *
 * Verbose diagnose: laat per Bol-order zien:
 *   1. Wat zit er in onze gecachede order.items (uit /api/cron/bol-orders)
 *   2. Wat returnt de live /orders/{id} detail-call (raw orderItems)
 *   3. Welke EAN wordt geextraheerd per item, langs welk veld
 *   4. Welke veld-keys staan er op de Bol-orderItems (zien we iets onverwachts?)
 *   5. Resultaat van de lookup voor die EAN tegen onze cache
 *
 * Doel: zien WAAR in de chain de EAN verloren raakt zodat push-orders skipped
 * worden ondanks dat de EANs WEL in Shopify + cache zitten.
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readBolOrders } from '../../lib/bol-orders.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { bolGet, bolOrdersVersion } from '../../lib/bol-client.js';

export const maxDuration = 60;

const clean = (v) => String(v == null ? '' : v).trim();

function extractEanFromItem(it) {
  /* Probeer ALLE bekende EAN-velden + log welk pad raak was */
  const paths = [
    ['ean', it.ean],
    ['barcode', it.barcode],
    ['gtin', it.gtin],
    ['eanCode', it.eanCode],
    ['globalTradeItemNumber', it.globalTradeItemNumber],
    ['product.ean', it.product?.ean],
    ['product.barcode', it.product?.barcode],
    ['product.gtin', it.product?.gtin],
    ['product.eanCode', it.product?.eanCode],
    ['offer.ean', it.offer?.ean],
    ['offer.barcode', it.offer?.barcode]
  ];
  for (const [path, val] of paths) {
    const v = clean(val);
    if (v) return { ean: v, foundAt: path };
  }
  return { ean: '', foundAt: null };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const specificOrderId = clean(req.query.orderId);
  const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 3));

  try {
    const [bolData, cache] = await Promise.all([
      readBolOrders().catch(() => null),
      readProductsCache().catch(() => null)
    ]);

    if (!bolData) return res.status(500).json({ success: false, message: 'Geen bol-orders-cache.' });
    if (!cache) return res.status(500).json({ success: false, message: 'Geen Shopify-cache.' });

    const allOrders = Array.isArray(bolData.orders) ? bolData.orders : [];
    const target = specificOrderId
      ? allOrders.filter((o) => clean(o.orderId || o.id) === specificOrderId)
      : allOrders.slice(0, limit);

    if (!target.length) {
      return res.status(404).json({
        success: false,
        message: specificOrderId ? `Order ${specificOrderId} niet in cache.` : 'Geen orders in cache.',
        availableOrderIds: allOrders.slice(0, 20).map((o) => clean(o.orderId || o.id))
      });
    }

    const results = [];
    for (const order of target) {
      const orderId = clean(order.orderId || order.id);
      const cachedItems = order.items || [];

      /* Live detail-call */
      let detailResult;
      try {
        const detail = await bolGet(`/orders/${encodeURIComponent(orderId)}`, { version: bolOrdersVersion() });
        detailResult = { ok: true, raw: detail };
      } catch (e) {
        detailResult = { ok: false, error: e.message || 'detail-call mislukt' };
      }

      /* Voor elk gecachede item: wat is de EAN, kan cache het matchen? */
      const cachedItemDiagnose = cachedItems.map((it) => {
        const { ean, foundAt } = extractEanFromItem(it);
        const cacheHit = ean ? cache?.byBarcode?.[ean.toLowerCase()] : null;
        return {
          source: 'cached-order-items',
          ean,
          eanFoundAt: foundAt,
          offerReference: clean(it.offerReference || it.offer?.reference),
          qty: it.qty || it.quantity || 1,
          titel: clean(it.titel || it.product?.title),
          itemKeys: Object.keys(it || {}),
          cacheHit: cacheHit ? {
            variantId: cacheHit.shopifyVariantId,
            sku: cacheHit.sku,
            barcode: cacheHit.barcode,
            title: cacheHit.title
          } : null
        };
      });

      /* Voor elk detail-item: wat is de EAN, kan cache het matchen? */
      const detailItemsDiagnose = detailResult.ok
        ? (detailResult.raw?.orderItems || []).map((di) => {
            const { ean, foundAt } = extractEanFromItem(di);
            const cacheHit = ean ? cache?.byBarcode?.[ean.toLowerCase()] : null;
            return {
              source: 'live-detail-call',
              ean,
              eanFoundAt: foundAt,
              offerReference: clean(di.offer?.reference || di.offerReference),
              quantity: di.quantity,
              unitPrice: di.unitPrice,
              productTitle: clean(di.product?.title),
              itemKeys: Object.keys(di || {}),
              productKeys: di.product ? Object.keys(di.product) : null,
              offerKeys: di.offer ? Object.keys(di.offer) : null,
              cacheHit: cacheHit ? {
                variantId: cacheHit.shopifyVariantId,
                sku: cacheHit.sku,
                barcode: cacheHit.barcode,
                title: cacheHit.title
              } : null
            };
          })
        : null;

      results.push({
        orderId,
        placedAt: clean(order.datum || order.orderPlacedDateTime),
        cachedItemCount: cachedItems.length,
        cachedItemDiagnose,
        detailCallOk: detailResult.ok,
        detailCallError: detailResult.error || null,
        detailItemCount: detailResult.ok ? (detailResult.raw?.orderItems?.length || 0) : null,
        detailTopLevelKeys: detailResult.ok ? Object.keys(detailResult.raw || {}) : null,
        detailItemsDiagnose
      });
    }

    /* Aggregatie: hoeveel EAN's gevonden vs gemist, langs welke paden */
    const stats = { totalItems: 0, withEan: 0, withoutEan: 0, withCacheHit: 0, foundAtPaths: {} };
    for (const r of results) {
      const allItems = [...(r.cachedItemDiagnose || []), ...(r.detailItemsDiagnose || [])];
      for (const it of allItems) {
        stats.totalItems += 1;
        if (it.ean) {
          stats.withEan += 1;
          stats.foundAtPaths[it.eanFoundAt] = (stats.foundAtPaths[it.eanFoundAt] || 0) + 1;
        } else {
          stats.withoutEan += 1;
        }
        if (it.cacheHit) stats.withCacheHit += 1;
      }
    }

    return res.status(200).json({
      success: true,
      examined: results.length,
      cacheBarcodeCount: Object.keys(cache.byBarcode || {}).length,
      stats,
      results
    });
  } catch (e) {
    console.error('[admin/bol-order-debug]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
