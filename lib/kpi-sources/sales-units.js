/**
 * KPI-source: sales_units — verkochte stuks via kassa + weborder.
 *
 * STATUS: stub. Wire-up gids:
 *   - Gebruik srs-revenue-cache: payload heeft soms `units` of `quantity` veld.
 *   - Of derive uit SRS-bonnen (per-branch transactie-tellingen).
 *   - Plus weborders (count van verzonden orders × regel-tellingen).
 *
 * Tot wire-up: returnt null, framework toont '–' in UI.
 */
export default async function compute(/* ctx */) {
  return { value: null, meta: { status: 'not-implemented', hint: 'Wire up via SRS bonnen + weborders count' } };
}
