import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { readBranchSnapshot } from '../../lib/srs-stock-snapshot-store.js';
import { listAllBranches, getStoreNameByBranchId, isWarehouseStore } from '../../lib/branch-metrics.js';
import { getAllOpenstaandeUitwisselingen } from '../../lib/srs-exchanges-client.js';

/**
 * GET /api/store/stock-lookup?barcode=XXX or ?sku=YYY
 *
 * Winkel-tool: zoek artikel-voorraad over ALLE branches + check lopende
 * uitwisselingen. Geen admin-token nodig (winkel-medewerkers gebruiken het).
 *
 * Response:
 *   {
 *     success,
 *     query: { barcode, sku },
 *     item: { barcode, sku, title, color, size },     // metadata van eerste match
 *     totalPieces,
 *     branchCount,                                     // # branches met voorraad
 *     branches: [
 *       { branchId, store, pieces, type:'retail|warehouse', updatedAt, isOwn? }
 *     ],
 *     exchanges: {
 *       count,                                         // totaal lopende uitwisselingen met dit item
 *       byBranch: [...],                               // verzameld per van-naar
 *       items: [{ uitwisselingId, vanWinkel, naarWinkel, aantal, createdAt, sellerName }]
 *     }
 *   }
 *
 * Cache: exchanges 5 min in-memory (zwaar SOAP-call).
 */

const EXCHANGES_CACHE_TTL_MS = Number(process.env.STOCK_LOOKUP_EXCH_CACHE_MS || 5 * 60 * 1000);
let exchangesCache = { at: 0, data: null };

function clean(v) { return String(v || '').trim(); }
function eqBarcode(a, b) {
  return clean(a).toLowerCase() === clean(b).toLowerCase();
}

async function getCachedExchanges() {
  if (exchangesCache.data && (Date.now() - exchangesCache.at) < EXCHANGES_CACHE_TTL_MS) {
    return { data: exchangesCache.data, fromCache: true };
  }
  try {
    const r = await getAllOpenstaandeUitwisselingen({ days: 60 });
    exchangesCache = { at: Date.now(), data: r };
    return { data: r, fromCache: false };
  } catch (error) {
    console.warn('[stock-lookup] exchanges fetch faalde:', error.message);
    return { data: { exchanges: [], error: error.message }, fromCache: false };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  const barcode = clean(req.query.barcode);
  const sku = clean(req.query.sku);
  const ownStore = clean(req.query.store); /* huidige winkel voor highlight */

  if (!barcode && !sku) {
    return res.status(400).json({ success: false, message: 'Geef barcode of sku mee.' });
  }

  const queryValue = barcode || sku;

  try {
    /* Parallel: alle branch-snapshots + open uitwisselingen */
    const allBranches = listAllBranches();
    const branchIds = allBranches.map((b) => b.branchId).filter(Boolean);

    const [snapshots, exchangesResult] = await Promise.all([
      Promise.all(branchIds.map(async (bid) => {
        try {
          const snap = await readBranchSnapshot(bid);
          return { branchId: bid, snap };
        } catch {
          return { branchId: bid, snap: null };
        }
      })),
      getCachedExchanges()
    ]);

    /* Filter rows per branch op de barcode/sku */
    const branches = [];
    let item = null;
    for (const { branchId, snap } of snapshots) {
      if (!snap || !Array.isArray(snap.rows)) continue;
      const matchingRows = snap.rows.filter((r) => {
        if (barcode && eqBarcode(r.barcode, barcode)) return true;
        if (sku && (eqBarcode(r.sku, sku) || eqBarcode(r.barcode, sku))) return true;
        return false;
      });
      if (!matchingRows.length) continue;

      /* Eerste niet-lege metadata wint */
      if (!item) {
        const first = matchingRows[0];
        item = {
          barcode: clean(first.barcode),
          sku: clean(first.sku || first.barcode),
          title: clean(first.title || ''),
          color: clean(first.color || ''),
          size: clean(first.size || '')
        };
      }

      const branchName = getStoreNameByBranchId(branchId);
      const pieces = matchingRows.reduce((s, r) => s + Number(r.pieces || 0), 0);

      branches.push({
        branchId,
        store: branchName,
        pieces,
        type: isWarehouseStore(branchName) ? 'warehouse' : 'retail',
        updatedAt: snap.updatedAt || null,
        isOwn: ownStore && branchName === ownStore
      });
    }

    /* Sort: eigen winkel bovenaan, dan met voorraad > 0 op aantal aflopend,
       dan rest alfabetisch */
    branches.sort((a, b) => {
      if (a.isOwn && !b.isOwn) return -1;
      if (!a.isOwn && b.isOwn) return 1;
      if (a.pieces !== b.pieces) return b.pieces - a.pieces;
      return a.store.localeCompare(b.store);
    });

    const totalPieces = branches.reduce((s, b) => s + b.pieces, 0);

    /* Filter exchanges op deze barcode */
    const matchingExchanges = [];
    for (const exch of (exchangesResult.data.exchanges || [])) {
      const hasItem = (exch.items || []).some((it) => {
        if (barcode && (eqBarcode(it.barcode, barcode) || eqBarcode(it.sku, barcode))) return true;
        if (sku && (eqBarcode(it.sku, sku) || eqBarcode(it.barcode, sku))) return true;
        return false;
      });
      if (!hasItem) continue;
      /* Aantal pieces in deze specifieke uitwisseling voor deze barcode */
      const itemsInExchange = (exch.items || []).filter((it) =>
        (barcode && (eqBarcode(it.barcode, barcode) || eqBarcode(it.sku, barcode))) ||
        (sku && (eqBarcode(it.sku, sku) || eqBarcode(it.barcode, sku)))
      );
      const aantalInExchange = itemsInExchange.reduce((s, i) => s + Number(i.aantal || 0), 0);
      matchingExchanges.push({
        uitwisselingId: exch.uitwisselingId,
        vanFiliaal: exch.vanFiliaal,
        vanWinkel: exch.vanWinkel,
        naarFiliaal: exch.naarFiliaal,
        naarWinkel: exch.naarWinkel,
        sellerName: exch.sellerName || exch.verkoper || '',
        createdAt: exch.createdAt || exch.aangemaaktOp || '',
        aantal: aantalInExchange,
        totalItemsInExchange: exch.itemCount
      });
    }

    matchingExchanges.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

    return res.status(200).json({
      success: true,
      query: { barcode, sku, value: queryValue },
      item,
      totalPieces,
      branchCount: branches.length,
      branches,
      exchanges: {
        count: matchingExchanges.length,
        aantal: matchingExchanges.reduce((s, e) => s + Number(e.aantal || 0), 0),
        items: matchingExchanges
      },
      exchangesFromCache: exchangesResult.fromCache,
      exchangesError: exchangesResult.data.error || null,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[stock-lookup] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Voorraad-lookup mislukt.'
    });
  }
}
