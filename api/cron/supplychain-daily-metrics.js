/**
 * Cron: bouw dagelijkse supplychain metric-snapshot per filiaal.
 *
 * Loopt 1× per dag (Vercel cron schedule). Per filiaal worden alle
 * geconfigureerde metrics berekend voor de DAG van GISTEREN, en opgeslagen
 * in admin/supplychain-snapshots/{yyyy-mm-dd}.json.
 *
 * Bij elke nieuwe metric (placeholder of real) wordt de cron-output ververst —
 * geen frontend-deploy nodig.
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { readMetricsConfig } from '../../lib/supplychain-metrics-config.js';
import { computeMetricsForBranch } from '../../lib/supplychain-metrics-fetchers.js';
import { writeDaySnapshot } from '../../lib/supplychain-metrics-store.js';
import { getSrsBranchMap } from '../../lib/srs-branches.js';

function yesterdayIso() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function handler(req, res) {
  const secret = process.env.SUPPLYCHAIN_CRON_SECRET || '';
  const incoming = String(req.headers.authorization || req.query.secret || '')
    .replace(/^Bearer\s+/i, '').trim();
  if (secret && incoming !== secret) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  /* Welke datum bouwen we? Standaard = gisteren, of ?date=YYYY-MM-DD override */
  const targetDate = String(req.query.date || '').match(/^\d{4}-\d{2}-\d{2}$/)
    ? req.query.date
    : yesterdayIso();

  try {
    const { metrics } = await readMetricsConfig();
    const enabledMetrics = metrics.filter((m) => m.enabled);
    const branchMap = getSrsBranchMap();

    /* Voor elke (store, branchId) compute metrics. Sequentieel ipv parallel
       om SRS rate-limit en Blob-storm te vermijden — er zijn ~22 winkels,
       400ms/branch is ~9s totaal. */
    const branches = [];
    for (const [store, branchId] of Object.entries(branchMap)) {
      if (!branchId) continue; /* skip winkels zonder branchId */
      const computed = await computeMetricsForBranch(enabledMetrics, {
        branchId,
        store,
        dateStr: targetDate
      });
      branches.push({ branchId, store, metrics: computed });
    }

    await writeDaySnapshot(targetDate, {
      date: targetDate,
      generatedAt: new Date().toISOString(),
      metricKeys: enabledMetrics.map((m) => m.key),
      branches
    });

    return res.status(200).json({
      success: true,
      date: targetDate,
      branchCount: branches.length,
      metricCount: enabledMetrics.length,
      sample: branches[0] || null
    });
  } catch (error) {
    console.error('[supplychain-daily-metrics]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Snapshot mislukt.'
    });
  }
}

export default trackedCron('supplychain-daily-metrics', handler);
