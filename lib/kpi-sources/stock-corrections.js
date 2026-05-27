/**
 * KPI-source: stock_corrections — aantal voorraad-correcties per winkel/periode.
 *
 * Wraps lib/stock-corrections-store.js (al bestaand voor admin-pagina).
 */
import { listStockCorrections } from '../stock-corrections-store.js';

export default async function compute({ store, fromDate, toDate } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  try {
    const all = await listStockCorrections({ store, fromDate, toDate });
    return {
      value: Array.isArray(all) ? all.length : 0,
      meta: { computedAt: new Date().toISOString() }
    };
  } catch (e) {
    return { value: null, meta: { error: e.message } };
  }
}
