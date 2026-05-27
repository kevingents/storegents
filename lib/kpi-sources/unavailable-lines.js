/**
 * KPI-source: unavailable_lines — % orderregels niet-leverbaar.
 *
 * Wire-up: aggregeer unavailable-cron-state-store + weborders-totaal.
 */
export default async function compute({ store } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  return { value: null, meta: { status: 'not-implemented' } };
}
