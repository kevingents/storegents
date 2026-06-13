import { readBranchSnapshot } from './srs-stock-snapshot-store.js';
import { listAllBranches, getStoreNameByBranchId, isWarehouseStore } from './branch-metrics.js';

/**
 * Voorraad per winkel voor een set SKU's/barcodes, uit de SRS-branch-snapshots
 * (Vercel Blob, dagelijks/cron bijgewerkt). Bron voor "alleen op voorraad"-filters
 * en de voorraad-per-winkel weergave bij de order-route.
 *
 * @param {string[]} skus  SKU's of barcodes
 * @returns {Promise<Object>} { '<sku>': { byStore:[{store,branchId,pieces,warehouse}],
 *                              total, inStockStores:[namen] } }
 */
const lower = (v) => String(v == null ? '' : v).trim().toLowerCase();

export async function stockBySkus(skus = []) {
  const wanted = new Set((Array.isArray(skus) ? skus : []).map(lower).filter(Boolean));
  const out = {};
  for (const s of wanted) out[s] = { byStore: [], total: 0, inStockStores: [] };
  if (!wanted.size) return out;

  const branches = listAllBranches();
  const snaps = await Promise.all(branches.map(async (b) => {
    try {
      return { branchId: b.branchId, store: getStoreNameByBranchId(b.branchId), snap: await readBranchSnapshot(b.branchId) };
    } catch {
      return null;
    }
  }));

  for (const s of snaps) {
    if (!s?.snap?.rows?.length) continue;
    for (const r of s.snap.rows) {
      const rs = lower(r.sku);
      const rb = lower(r.barcode);
      const key = wanted.has(rs) ? rs : (wanted.has(rb) ? rb : null);
      if (!key) continue;
      const pieces = Number(r.pieces || 0);
      out[key].byStore.push({
        store: s.store,
        branchId: s.branchId,
        pieces,
        warehouse: isWarehouseStore(s.store),
      });
      out[key].total += pieces;
      if (pieces > 0 && s.store) out[key].inStockStores.push(s.store);
    }
  }

  for (const k of wanted) {
    out[k].byStore.sort((a, b) => b.pieces - a.pieces);
    out[k].inStockStores = [...new Set(out[k].inStockStores)];
  }
  return out;
}
