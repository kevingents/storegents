import { syncSrsCancellationsForBranch, boolEnv, monthFromValue, statusListFromValue, branchFromInput } from '../../../lib/srs-cancellation-sync-service.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!requireAdmin(req, res)) return;

  if (!boolEnv('SRS_CANCELLATION_SYNC_ENABLED', true)) {
    return res.status(200).json({
      success: true,
      disabled: true,
      message: 'SRS annuleringen synchroniseren staat uit via SRS_CANCELLATION_SYNC_ENABLED=false.',
      created: 0,
      duplicates: 0,
      scanned: 0,
      errors: []
    });
  }

  const store = String(req.query.store || req.body?.store || '').trim();
  const branchId = String(req.query.branchId || req.body?.branchId || '').trim();
  const branch = branchFromInput({ store, branchId });

  if (!branch?.branchId) {
    return res.status(400).json({
      success: false,
      message: 'Kies één winkel of geef branchId mee. Alle winkels tegelijk synchroniseren is uitgeschakeld om SRS en Vercel time-outs te voorkomen.',
      example: '/api/admin/order-cancellations/sync-srs?month=2026-04&store=GENTS%20Groningen'
    });
  }

  try {
    const startedAt = Date.now();
    const result = await syncSrsCancellationsForBranch({
      store: branch.store,
      branchId: branch.branchId,
      month: monthFromValue(req.query.month || req.body?.month),
      dryRun: String(req.query.dryRun || req.body?.dryRun || '').toLowerCase() === 'true',
      statuses: statusListFromValue(req.query.statuses || req.body?.statuses),
      startedAt,
      maxRuntimeMs: Number(process.env.SRS_CANCELLATION_SYNC_MAX_RUNTIME_MS || 22000),
      maxRecords: Number(process.env.SRS_CANCELLATION_SYNC_MAX_RECORDS || 50)
    });

    return res.status(200).json(result);
  } catch (error) {
    console.error('SRS cancellation sync error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'SRS annuleringen konden niet worden gesynchroniseerd.'
    });
  }
}
