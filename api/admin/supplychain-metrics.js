import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readMetricsConfig } from '../../lib/supplychain-metrics-config.js';
import {
  readRange,
  aggregateSnapshots,
  periodToRange
} from '../../lib/supplychain-metrics-store.js';

/**
 * GET /api/admin/supplychain-metrics
 *
 * Query:
 *   - period: 'week' | 'month' | 'quarter' | 'year' | 'custom'   (default: month)
 *   - from, to: yyyy-mm-dd  (override of vereist bij period=custom)
 *   - store:  optionele filter op winkel-naam
 *
 * Response:
 *   {
 *     success,
 *     period: { from, to, period },
 *     metrics: [...metricDefs met thresholds + status per branch],
 *     byBranch: { branchId: { store, metrics: { key: value } } },
 *     totals: { key: sumValue },
 *     dayCount, branchCount
 *   }
 *
 * Voor heatmap/dashboard. Branch-status (good/warn/danger) wordt
 * client-side berekend obv direction + thresholds — backend stuurt rauwe waarden.
 */

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const period = String(req.query.period || 'month').trim().toLowerCase();
    const storeFilter = String(req.query.store || '').trim();

    let range;
    if (req.query.from && req.query.to) {
      range = {
        from: String(req.query.from).slice(0, 10),
        to: String(req.query.to).slice(0, 10),
        period: 'custom'
      };
    } else {
      range = periodToRange(period);
    }

    const [{ metrics }, days] = await Promise.all([
      readMetricsConfig(),
      readRange(range.from, range.to)
    ]);

    const enabledMetrics = metrics.filter((m) => m.enabled);
    const agg = aggregateSnapshots(days, enabledMetrics);

    /* Filter on store als gevraagd */
    let byBranch = agg.byBranch;
    if (storeFilter) {
      const lower = storeFilter.toLowerCase();
      byBranch = Object.fromEntries(
        Object.entries(agg.byBranch).filter(([, v]) =>
          String(v.store || '').toLowerCase().includes(lower)
        )
      );
    }

    return res.status(200).json({
      success: true,
      period: range,
      metrics: enabledMetrics,
      byBranch,
      totals: agg.totals,
      dayCount: agg.dayCount,
      branchCount: Object.keys(byBranch).length,
      hasData: agg.dayCount > 0
    });
  } catch (error) {
    console.error('[admin/supplychain-metrics]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Metrics konden niet worden opgehaald.'
    });
  }
}
