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

/**
 * Verrijk een lijst orderregels met voorraad-info, in één snapshot-pass.
 * Per regel komt er een `stock`-veld bij:
 *   { here, total, inStockStores, known }
 * waarbij `here` = stuks in de gegeven winkel (relevant voor "kan ik 'm leveren
 * of bounce ie"). Faalt de lookup, dan krijgen alle regels stock.known=false en
 * blijft de lijst gewoon werken.
 *
 * @param {Array<Object>} requests  regels met .sku en/of .barcode
 * @param {string} storeName        winkel waarvoor 'here' geldt
 */
export async function attachStockForStore(requests, storeName) {
  const list = Array.isArray(requests) ? requests : [];
  const wantStore = lower(storeName);
  const keys = [];
  for (const r of list) {
    if (r?.sku) keys.push(r.sku);
    if (r?.barcode) keys.push(r.barcode);
  }
  let stock = {};
  try {
    stock = await stockBySkus(keys);
  } catch {
    return list.map((r) => ({ ...r, stock: { here: 0, total: 0, inStockStores: [], known: false } }));
  }
  return list.map((r) => {
    const s = stock[lower(r?.sku)] || stock[lower(r?.barcode)];
    if (!s) return { ...r, stock: { here: 0, total: 0, inStockStores: [], known: false } };
    const here = wantStore
      ? (s.byStore.find((b) => lower(b.store) === wantStore)?.pieces || 0)
      : 0;
    return {
      ...r,
      stock: { here, total: s.total, inStockStores: s.inStockStores, known: true },
    };
  });
}
