import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { realtimeStockForVariants } from '../../lib/shopify-realtime-search.js';
import { readBranchSnapshot } from '../../lib/srs-stock-snapshot-store.js';
import { listAllBranches, getStoreNameByBranchId, isWarehouseStore } from '../../lib/branch-metrics.js';

/**
 * POST /api/store/article-stock
 *
 * Stock-lookup voor een lijst variants. Combineert TWEE bronnen:
 *
 *  1. Shopify-realtime inventory (via GraphQL bulk fetch)
 *     - Voordeel: live, webshop-aankopen direct verwerkt
 *     - Nadeel: Shopify-SRS sync is soms niet up-to-date → toont 0 terwijl
 *       SRS wel voorraad heeft (gevonden bij Rokjas polywol)
 *
 *  2. SRS branch-snapshots (uit Vercel Blob, dagelijks bijgewerkt via cron)
 *     - Voordeel: 1-op-1 met SRS-POS, accurate winkel-voorraad
 *     - Nadeel: tot 24u oud
 *
 *  Per branch per variant: pak max(shopify, srs). Zo combineren we het beste
 *  van beide werelden: live Shopify-aankopen meegenomen, maar fallback op SRS
 *  als Shopify-data hapert.
 *
 * Body:
 *   {
 *     variantIds: ['gid://shopify/ProductVariant/123', ...],   // max 200
 *     lookups: [{variantId, barcode, sku}],                     // optioneel,
 *                voor SRS-fallback. Zonder dit alleen Shopify-data.
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
function lower(v) { return clean(v).toLowerCase(); }

const MAX_VARIANTS = 200;

/**
 * Lees SRS branch-snapshots en match variants op barcode/sku.
 * Returned: { variantId: { branches: [...], totalPieces, branchCount } }
 */
async function loadSrsStockForVariants(lookupByVariant, ownStore) {
  const branches = listAllBranches();
  const snapshots = await Promise.all(branches.map(async (b) => {
    try { return { branchId: b.branchId, snap: await readBranchSnapshot(b.branchId) }; }
    catch { return { branchId: b.branchId, snap: null }; }
  }));

  /* Per variant: verzamel branches met stock */
  const stocksByVariant = {};
  for (const [variantId, { barcode, sku }] of lookupByVariant) {
    const variantBranches = [];
    let totalPieces = 0;
    let branchCount = 0;
    for (const { branchId, snap } of snapshots) {
      if (!snap?.rows?.length) continue;
      const storeName = getStoreNameByBranchId(branchId);
      /* Zoek matchende row in deze branch — match op barcode of sku */
      const hit = snap.rows.find((r) => {
        const rb = lower(r.barcode);
        const rs = lower(r.sku);
        return (barcode && rb === barcode) || (sku && rs === sku);
      });
      if (!hit) continue;
      const pieces = Number(hit.pieces || 0);
      totalPieces += pieces;
      if (pieces > 0) branchCount += 1;
      variantBranches.push({
        branchId,
        store: storeName,
        pieces,
        isOwn: ownStore && storeName === ownStore,
        type: isWarehouseStore(storeName) ? 'warehouse' : 'retail',
        source: 'srs'
      });
    }
    if (variantBranches.length) {
      stocksByVariant[variantId] = { branches: variantBranches, totalPieces, branchCount };
    }
  }
  return stocksByVariant;
}

/**
 * Merge Shopify + SRS stock per variant. Per branch: pak hoogste pieces.
 * Branches die in 1 bron zitten worden behouden. Source-label per branch.
 */
function mergeStockSources(shopifyStocks, srsStocks, ownStore) {
  const out = {};
  const allVariantIds = new Set([
    ...Object.keys(shopifyStocks || {}),
    ...Object.keys(srsStocks || {})
  ]);
  for (const vid of allVariantIds) {
    const sh = shopifyStocks?.[vid];
    const sr = srsStocks?.[vid];
    /* Maak per-store map en pak max */
    const byStore = new Map();
    for (const b of (sh?.branches || [])) {
      byStore.set(b.store, { ...b, source: 'shopify' });
    }
    for (const b of (sr?.branches || [])) {
      const existing = byStore.get(b.store);
      if (!existing || b.pieces > (existing.pieces || 0)) {
        /* SRS heeft meer → vervang en label als srs (of beide) */
        byStore.set(b.store, {
          ...b,
          source: existing ? 'srs+shopify' : 'srs',
          shopifyPieces: existing?.pieces || 0,
          srsPieces: b.pieces
        });
      } else if (existing) {
        existing.srsPieces = b.pieces;
        existing.source = 'shopify+srs';
      }
    }
    const branches = Array.from(byStore.values());
    branches.sort((a, b) => {
      if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
      if (a.pieces !== b.pieces) return b.pieces - a.pieces;
      return String(a.store || '').localeCompare(String(b.store || ''));
    });
    const totalPieces = branches.reduce((s, b) => s + Number(b.pieces || 0), 0);
    const branchCount = branches.filter((b) => b.pieces > 0).length;
    out[vid] = {
      branches,
      totalPieces,
      branchCount,
      inventoryFetched: true,
      sources: {
        shopify: Boolean(sh),
        srs: Boolean(sr)
      }
    };
  }
  return out;
}

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

    /* Lookups voor SRS-fallback: {variantId, barcode, sku}. Frontend stuurt
       deze mee zodat we per variant kunnen matchen tegen branch-snapshots. */
    const lookups = Array.isArray(body.lookups) ? body.lookups : [];
    const lookupByVariant = new Map();
    for (const l of lookups) {
      const vid = clean(l?.variantId);
      if (!vid) continue;
      lookupByVariant.set(vid, {
        barcode: clean(l.barcode).toLowerCase(),
        sku: clean(l.sku).toLowerCase()
      });
    }

    /* Parallel: Shopify-realtime + SRS-snapshot reads (alleen als lookups). */
    const [shopifyResult, srsStockByVariant] = await Promise.all([
      realtimeStockForVariants({ variantIds, ownStore }),
      lookupByVariant.size ? loadSrsStockForVariants(lookupByVariant, ownStore) : Promise.resolve({})
    ]);

    /* Merge: per variant per branch, pak hoogste van shopify/srs. Branches die
       in 1 van beide bronnen zitten worden behouden. Markeer source per
       branch zodat UI eventueel kan tonen 'Shopify: 0 / SRS: 3'. */
    const stocks = mergeStockSources(shopifyResult.stocks, srsStockByVariant, ownStore);

    const durationMs = Date.now() - startedAt;

    return res.status(200).json({
      success: true,
      stocks,
      inventoryStatus: {
        ...shopifyResult.inventoryStatus,
        srsLookups: lookupByVariant.size,
        srsHits: Object.keys(srsStockByVariant).length
      },
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
