/**
 * KPI-source: on_time_delivery — % weborders dat binnen deadline is verwerkt.
 *
 * Wire-up gids:
 *   1. listWeborders voor periode + store
 *   2. Per order: deadline = createdAt + BUSINESS_CONFIG.deadlines.weborderOperationalDays
 *   3. Counts: total, onTime (= picked|sent before deadline), late
 *   4. Return: (onTime / total) × 100
 *
 * Voor v1: stub (data al beschikbaar in srs-open-weborders-client maar
 * vereist careful aggregation per store + period).
 */
export default async function compute({ store, fromDate, toDate } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  return {
    value: null,
    meta: {
      status: 'not-implemented',
      hint: 'Aggregate weborders per store, compare picked-at vs createdAt+deadline',
      store, fromDate, toDate
    }
  };
}
