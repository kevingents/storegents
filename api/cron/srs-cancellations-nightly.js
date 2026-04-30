import { listBranches } from '../../lib/branch-metrics.js';
import { getCronState, saveCronState, appendCronRun } from '../../lib/cron-state-store.js';
import { syncSrsCancellationsForBranch, boolEnv, currentMonth, statusListFromValue } from '../../lib/srs-cancellation-sync-service.js';

const DEFAULT_MAX_RUNTIME_MS = 22000;

function isAuthorizedCron(req) {
  const expected = process.env.CRON_SECRET || '';
  const auth = String(req.headers.authorization || '');
  const querySecret = String(req.query.secret || '');
  const userAgent = String(req.headers['user-agent'] || '');

  if (!expected) {
    return userAgent.includes('vercel-cron/1.0');
  }

  return auth === `Bearer ${expected}` || querySecret === expected;
}

function monthForCron() {
  return /^\d{4}-\d{2}$/.test(String(process.env.SRS_CANCELLATION_CRON_MONTH || ''))
    ? String(process.env.SRS_CANCELLATION_CRON_MONTH)
    : currentMonth();
}

function selectedBranchesFromState(branches, startIndex, batchSize) {
  if (!branches.length) return [];

  const selected = [];
  for (let i = 0; i < batchSize; i += 1) {
    const index = (startIndex + i) % branches.length;
    selected.push({ ...branches[index], index });
  }
  return selected;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd voor cron.' });
  }

  if (!boolEnv('SRS_CANCELLATION_SYNC_ENABLED', true)) {
    return res.status(200).json({ success: true, disabled: true, message: 'SRS cancellation sync staat uit.' });
  }

  const startedAt = Date.now();
  const maxRuntimeMs = Number(process.env.SRS_CANCELLATION_CRON_MAX_RUNTIME_MS || process.env.SRS_CANCELLATION_SYNC_MAX_RUNTIME_MS || DEFAULT_MAX_RUNTIME_MS);
  const batchSize = Math.max(1, Number(process.env.SRS_CANCELLATION_CRON_BATCH_SIZE || 1));
  const maxRecords = Number(process.env.SRS_CANCELLATION_SYNC_MAX_RECORDS || 50);
  const month = String(req.query.month || monthForCron());
  const dryRun = String(req.query.dryRun || process.env.SRS_CANCELLATION_CRON_DRY_RUN || '').toLowerCase() === 'true';
  const statuses = statusListFromValue(req.query.statuses || process.env.SRS_CANCELLATION_SYNC_STATUSES || '');
  const branches = listBranches().filter((branch) => String(branch.store || '').trim() && String(branch.branchId || '').trim());

  if (!branches.length) {
    return res.status(200).json({ success: true, message: 'Geen filialen gevonden in SRS_BRANCH_MAP_JSON.', branchesProcessed: 0 });
  }

  const state = await getCronState();
  const startIndex = Number.isFinite(Number(req.query.startIndex)) ? Number(req.query.startIndex) : Number(state.nextIndex || 0);
  const selected = selectedBranchesFromState(branches, startIndex, batchSize);

  const results = [];
  let nextIndex = startIndex;
  let stoppedForRuntime = false;

  for (const branch of selected) {
    if (Date.now() - startedAt > maxRuntimeMs - 4000) {
      stoppedForRuntime = true;
      break;
    }

    try {
      const result = await syncSrsCancellationsForBranch({
        store: branch.store,
        branchId: branch.branchId,
        month,
        dryRun,
        statuses,
        startedAt,
        maxRuntimeMs,
        maxRecords
      });
      results.push(result);
      nextIndex = (branch.index + 1) % branches.length;

      if (result.partial || Date.now() - startedAt > maxRuntimeMs - 4000) {
        stoppedForRuntime = true;
        break;
      }
    } catch (error) {
      results.push({
        success: false,
        store: branch.store,
        branchId: branch.branchId,
        message: error.message || 'Sync mislukt voor winkel.'
      });
      nextIndex = (branch.index + 1) % branches.length;
    }
  }

  const totals = results.reduce((acc, item) => {
    acc.created += Number(item.created || 0);
    acc.duplicates += Number(item.duplicates || 0);
    acc.scanned += Number(item.scanned || 0);
    acc.found += Number(item.found || 0);
    acc.errors += Array.isArray(item.errors) ? item.errors.length : item.success === false ? 1 : 0;
    return acc;
  }, { created: 0, duplicates: 0, scanned: 0, found: 0, errors: 0 });

  await saveCronState({
    ...state,
    nextIndex,
    lastRunAt: new Date().toISOString(),
    lastMonth: month,
    lastBatchSize: batchSize,
    lastDryRun: dryRun
  });

  await appendCronRun({
    month,
    dryRun,
    startIndex,
    nextIndex,
    batchSize,
    stoppedForRuntime,
    runtimeMs: Date.now() - startedAt,
    totals,
    stores: results.map((item) => ({
      store: item.store,
      branchId: item.branchId,
      success: item.success !== false,
      created: item.created || 0,
      duplicates: item.duplicates || 0,
      found: item.found || 0,
      scanned: item.scanned || 0,
      partial: item.partial || false,
      message: item.message || ''
    }))
  });

  return res.status(200).json({
    success: true,
    month,
    dryRun,
    branchCount: branches.length,
    batchSize,
    startIndex,
    nextIndex,
    stoppedForRuntime,
    runtimeMs: Date.now() - startedAt,
    totals,
    results,
    message: `Cron sync klaar. Volgende startIndex: ${nextIndex}.`
  });
}
