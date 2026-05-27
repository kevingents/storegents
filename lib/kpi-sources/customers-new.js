/**
 * KPI-source: customers_new — nieuwe klantinschrijvingen per winkel/maand.
 *
 * Wraps de bestaande srs-customers-client + customer-target-helpers logica.
 * Voor v1 returnt deze nog null — wire-up vereist async telling via SRS.
 *
 * Wire-up gids:
 *   1. import { listCustomers } from '../srs-customers-client.js'
 *   2. Filter op storeName + signupDate in [fromDate, toDate]
 *   3. Return count
 *
 * Status: stub
 */
export default async function compute({ store, fromDate, toDate } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  return {
    value: null,
    meta: {
      status: 'not-implemented',
      hint: 'Wrap srs-customers-client → filter on signupDate range + store',
      store,
      fromDate,
      toDate
    }
  };
}
