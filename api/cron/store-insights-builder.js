/**
 * Cron: GET /api/cron/store-insights-builder
 * Schedule: dagelijks 03:00 (zie vercel.json)
 *
 * Bouwt overnacht alle winkelinzicht-aggregaten op zodat het rapport
 * direct kan worden geserveerd uit Blob-cache (geen live SRS-call
 * bij elke modal-open).
 *
 * Werkwijze:
 *   1. Eén grote SRS getTransactions() voor de afgelopen 5 jaar
 *   2. Loop alle GENTS-branches langs
 *   3. Per branch × period (month/quarter/year/lifetime):
 *      aggregateInsights() + writeInsights() naar Blob
 *
 * Env-vars:
 *   ADMIN_TOKEN — voor handmatige trigger
 *   STORE_INSIGHTS_TIMEOUT_MS — optioneel (default 540000 = 9min)
 */

import { getTransactions } from '../../lib/srs-customers-client.js';
import { listBranches } from '../../lib/branch-metrics.js';
import { aggregateInsights, computeRange, PERIODS, isoDateTime } from '../../lib/store-insights-compute.js';
import { writeInsights } from '../../lib/store-insights-cache.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { isCronAuthorized } from '../../lib/cron-auth.js';

function isAuthorized(req) {
  return isCronAuthorized(req);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const startedAt = Date.now();
  const TIMEOUT_MS = Number(process.env.STORE_INSIGHTS_TIMEOUT_MS || 540000); /* 9 min */

  /* Datum-range: maximaal 5 jaar terug (lifetime) — alle kleinere
     perioden slicen we in-memory. */
  const now = new Date();
  const lifetimeFrom = new Date(now); lifetimeFrom.setFullYear(now.getFullYear() - 5); lifetimeFrom.setHours(0, 0, 0, 0);
  const fromIso = isoDateTime(lifetimeFrom);
  const untilIso = isoDateTime(now);

  let transactions = [];
  try {
    const result = await getTransactions({ from: fromIso, until: untilIso });
    transactions = Array.isArray(result?.transactions) ? result.transactions : [];
  } catch (error) {
    console.error('[store-insights-builder] SRS fetch fail:', error);
    return res.status(500).json({ success: false, message: `SRS transacties ophalen mislukt: ${error.message}` });
  }

  console.log(`[store-insights-builder] ${transactions.length} transacties opgehaald, periode ${fromIso} → ${untilIso}`);

  /* Optionele subset via query */
  const onlyStore = String(req.query.store || '').trim();
  const onlyPeriod = String(req.query.period || '').trim();
  const branches = listBranches();
  const targets = onlyStore
    ? branches.filter((b) => String(b.store).toLowerCase() === onlyStore.toLowerCase())
    : branches;
  const periods = onlyPeriod ? [onlyPeriod] : PERIODS;

  const results = [];
  let written = 0;
  let failed = 0;

  for (const branch of targets) {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.warn('[store-insights-builder] timeout — stoppen bij branch', branch.branchId);
      break;
    }
    for (const period of periods) {
      const { from, until } = computeRange(period);
      try {
        const agg = aggregateInsights(transactions, branch.branchId, from, until);
        agg.store = branch.store;
        agg.period = period;
        await writeInsights(branch.branchId, period, agg);
        written += 1;
        results.push({ store: branch.store, period, transactions: agg.totals.transactions, ok: true });
      } catch (error) {
        failed += 1;
        results.push({ store: branch.store, period, error: error.message });
      }
    }
  }

  const duration = Math.round((Date.now() - startedAt) / 1000);
  return res.status(200).json({
    success: true,
    duration: `${duration}s`,
    branchesProcessed: targets.length,
    periodsPerBranch: periods.length,
    transactionsScanned: transactions.length,
    written,
    failed,
    fromIso, untilIso,
    results: results.slice(0, 100) /* truncate response */
  });
}

export default trackedCron('store-insights-builder', handler);
