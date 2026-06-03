/**
 * KPI-source: stock_corrections — aantal voorraad-correcties per winkel/periode.
 *
 * Wraps lib/stock-corrections-store.js (al bestaand voor admin-pagina).
 */
import { listRequests } from '../stock-corrections-store.js';

export default async function compute({ store, fromDate, toDate } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  try {
    /* Fix: de store exporteert listRequests (niet listStockCorrections) en
       gebruikt from/to (niet fromDate/toDate). */
    const all = await listRequests({ store, from: fromDate, to: toDate });
    const arr = Array.isArray(all) ? all : (all?.requests || all?.rows || []);
    return {
      value: arr.length,
      meta: { computedAt: new Date().toISOString() }
    };
  } catch (e) {
    return { value: null, meta: { error: e.message } };
  }
}
