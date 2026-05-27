/**
 * KPI-source: online_warehouse_speed — gem. dagen tussen weborder-aanmaak en gepickt.
 *
 * Wire-up: voor weborders gepickt-in-periode, bereken (pickedAt - createdAt) in uren,
 * neem gemiddelde, deel door 24 voor dagen-uitkomst.
 */
export default async function compute({ store } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  return { value: null, meta: { status: 'not-implemented' } };
}
