/**
 * KPI-source: overdue_orders — openstaande weborders waarvan deadline is verlopen.
 *
 * Snapshot-KPI: telt momentane situatie op periode-einde, niet over periode.
 *
 * Wire-up: filter srs-open-weborders op (status === 'open' AND now > deadline).
 */
export default async function compute({ store } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  return { value: null, meta: { status: 'not-implemented' } };
}
