/**
 * KPI-source: omnichannel_score — composite 0-100 score per winkel.
 *
 * Wire-up: reuse de bestaande omnichannel-score-berekening uit
 * api/admin/omnichannel-score.js (extract logica naar lib/omnichannel-score.js
 * voor herbruikbaarheid). Tot dan: stub.
 */
export default async function compute({ store } = {}) {
  if (!store) return { value: null, meta: { error: 'store-required' } };
  return {
    value: null,
    meta: {
      status: 'not-implemented',
      hint: 'Extract logic from api/admin/omnichannel-score.js into reusable lib'
    }
  };
}
