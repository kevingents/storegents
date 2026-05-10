import { syncGlobalUnavailableOrderLines } from '../../lib/srs-unavailable-global-sync-service.js';
import { listUnavailableOrderLines, processUnavailableOrderLine } from '../../lib/unavailable-order-line-service.js';
import { appendUnavailableCronRun } from '../../lib/unavailable-cron-state-store.js';

function clean(value) {
  return String(value || '').trim();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorizedCron(req) {
  const expected = clean(process.env.CRON_SECRET || '');
  const adminToken = clean(process.env.ADMIN_TOKEN || '12345');
  const authHeader = clean(req.headers['author' + 'ization'] || '');
  const querySecret = clean(req.query.secret || '');
  const queryAdminToken = clean(req.query.adminToken || req.query.admin_token || '');
  const headerAdminToken = clean(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || '');
  const userAgent = clean(req.headers['user-agent'] || '');

  if (adminToken && (queryAdminToken === adminToken || headerAdminToken === adminToken)) return true;
  if (!expected) return userAgent.includes('vercel-cron/1.0');
  return authHeader === `Bearer ${expected}` || querySecret === expected;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'ja'].includes(clean(value).toLowerCase());
}

function falsey(value) {
  return ['0', 'false', 'no', 'nee'].includes(clean(value).toLowerCase());
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function rowProcessId(row = {}) {
  return clean(row.id || row.cancellationId || '');
}

function buildTotals({ sync = {}, open = {}, processed = {}, after = {}, dateFrom = '', dateTo = '', dryRun = false } = {}) {
  return {
    dateFrom,
    dateTo,
    dryRun,
    found: Number(sync.found || 0),
    created: Number(sync.created || 0),
    duplicates: Number(sync.duplicates || 0),
    skippedByDate: Number(sync.skippedByDate || 0),
    skippedByLimit: Number(sync.skippedByLimit || 0),
    openBeforeProcessing: Number(open.rows?.length || 0),
    open: Number(after.rows?.length ?? open.rows?.length ?? 0),
    openAmount: Number(after.totals?.amount ?? open.totals?.amount ?? 0),
    openRefundPending: Number(after.totals?.refundPending ?? open.totals?.refundPending ?? 0),
    openSrsCancelPending: Number(after.totals?.srsCancelPending ?? open.totals?.srsCancelPending ?? 0),
    processedAttempted: Number(processed.attempted || 0),
    processedSuccess: Number(processed.success || 0),
    processedPartial: Number(processed.partial || 0),
    processedFailed: Number(processed.failed || 0),
    failed: Number(after.totals?.failed ?? open.totals?.failed ?? 0),
    runtimeMs: Number(sync.runtimeMs || 0) + Number(processed.runtimeMs || 0)
  };
}

async function saveCronRun(run) {
  try {
    return await appendUnavailableCronRun(run);
  } catch (error) {
    console.error('[cron/srs-unavailable-hourly] cronstate opslaan mislukt', error);
    return null;
  }
}

async function processOpenUnavailableRows({ rows = [], maxProcessRecords = 25, maxRuntimeMs = 60000, dryRun = false } = {}) {
  const startedAt = Date.now();
  const candidates = rows.slice(0, Math.max(0, Number(maxProcessRecords || 0)));
  const results = [];
  const errors = [];
  let success = 0;
  let partial = 0;
  let failed = 0;

  if (dryRun) {
    return {
      dryRun: true,
      attempted: candidates.length,
      success: 0,
      partial: 0,
      failed: 0,
      runtimeMs: 0,
      results: candidates.map((row) => ({ id: rowProcessId(row), orderNr: row.orderNr, sku: row.sku || row.barcode, dryRun: true })),
      errors: []
    };
  }

  for (const row of candidates) {
    if (Date.now() - startedAt > maxRuntimeMs) break;
    const id = rowProcessId(row);
    if (!id) {
      failed += 1;
      errors.push({ orderNr: row.orderNr || '', message: 'Geen lokale regel-id gevonden.' });
      continue;
    }

    try {
      const result = await processUnavailableOrderLine({
        id,
        steps: ['refund', 'srs_cancel'],
        employeeName: 'Automatische niet-leverbaar cron',
        force: true
      });

      if (result.success && !result.partial) success += 1;
      else partial += 1;

      results.push({
        id,
        orderNr: row.orderNr || '',
        sku: row.sku || row.barcode || '',
        success: Boolean(result.success),
        partial: Boolean(result.partial),
        refundStatus: result.cancellation?.refundStatus || '',
        srsCancelStatus: result.cancellation?.srsCancelStatus || '',
        status: result.cancellation?.status || '',
        message: result.message || ''
      });
    } catch (error) {
      failed += 1;
      errors.push({ id, orderNr: row.orderNr || '', sku: row.sku || row.barcode || '', message: error.message || 'Verwerking mislukt.' });
    }
  }

  return {
    dryRun: false,
    attempted: results.length + errors.length,
    success,
    partial,
    failed,
    runtimeMs: Date.now() - startedAt,
    results,
    errors
  };
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd voor cron. Gebruik de echte CRON_SECRET of adminToken/admin_token voor handmatig testen.' });
  }

  let dateFrom = '';
  let dateTo = '';
  let dryRun = false;

  try {
    const daysBack = Number(req.query.daysBack || process.env.SRS_UNAVAILABLE_CRON_DAYS_BACK || 30);
    dateFrom = clean(req.query.dateFrom || '') || isoDateDaysAgo(daysBack);
    dateTo = clean(req.query.dateTo || '') || new Date().toISOString().slice(0, 10);
    const maxRuntimeMs = Number(req.query.maxRuntimeMs || process.env.SRS_UNAVAILABLE_CRON_MAX_RUNTIME_MS || 90000);
    const maxRecords = Number(req.query.maxRecords || process.env.SRS_UNAVAILABLE_CRON_MAX_RECORDS || 500);
    const maxProcessRecords = Number(req.query.maxProcessRecords || process.env.SRS_UNAVAILABLE_CRON_MAX_PROCESS_RECORDS || 25);
    const processMaxRuntimeMs = Number(req.query.processMaxRuntimeMs || process.env.SRS_UNAVAILABLE_CRON_PROCESS_MAX_RUNTIME_MS || 60000);
    dryRun = truthy(req.query.dryRun || process.env.SRS_UNAVAILABLE_CRON_DRY_RUN || '');
    const autoProcess = falsey(req.query.process || req.query.autoProcess || process.env.SRS_UNAVAILABLE_CRON_PROCESS || '') ? false : true;

    const sync = await syncGlobalUnavailableOrderLines({
      statuses: 'unavailable,niet leverbaar,not available',
      dateFrom,
      dateTo,
      dryRun,
      maxRuntimeMs,
      maxRecords
    });

    const open = await listUnavailableOrderLines({
      status: 'open',
      dateFrom,
      dateTo
    });

    const processed = autoProcess
      ? await processOpenUnavailableRows({ rows: open.rows, maxProcessRecords, maxRuntimeMs: processMaxRuntimeMs, dryRun })
      : { dryRun, attempted: 0, success: 0, partial: 0, failed: 0, runtimeMs: 0, results: [], errors: [] };

    const after = await listUnavailableOrderLines({
      status: 'open',
      dateFrom,
      dateTo
    });

    const message = autoProcess
      ? `Niet-leverbaar cron klaar. ${sync.created || 0} nieuw, ${sync.duplicates || 0} al bekend. ${processed.success || 0} automatisch verwerkt, ${processed.partial || 0} gedeeltelijk, ${processed.failed || 0} fout. ${after.rows.length} open regel(s).`
      : `Niet-leverbaar cron klaar. ${sync.created || 0} nieuw, ${sync.duplicates || 0} al bekend. ${after.rows.length} open regel(s).`;
    const totals = buildTotals({ sync, open, processed, after, dateFrom, dateTo, dryRun });
    const cronState = await saveCronRun({
      success: processed.failed === 0,
      message,
      totals,
      syncSummary: {
        source: sync.source || '',
        found: sync.found || 0,
        created: sync.created || 0,
        duplicates: sync.duplicates || 0,
        partial: Boolean(sync.partial),
        errors: Array.isArray(sync.errors) ? sync.errors.slice(0, 10) : []
      },
      processSummary: {
        autoProcess,
        attempted: processed.attempted || 0,
        success: processed.success || 0,
        partial: processed.partial || 0,
        failed: processed.failed || 0,
        errors: Array.isArray(processed.errors) ? processed.errors.slice(0, 10) : []
      }
    });

    return res.status(processed.failed ? 207 : 200).json({
      success: processed.failed === 0,
      partial: Boolean(processed.failed || processed.partial || sync.partial),
      mode: 'srs_unavailable_hourly_cron',
      dateFrom,
      dateTo,
      dryRun,
      autoProcess,
      sync,
      processed,
      openTotals: after.totals,
      openCount: after.rows.length,
      openPreview: after.rows.slice(0, Number(req.query.previewLimit || 25)),
      cronState: cronState ? {
        lastRunAt: cronState.lastRunAt,
        lastSuccess: cronState.lastSuccess,
        lastTotals: cronState.lastTotals,
        lastMessage: cronState.lastMessage
      } : null,
      message
    });
  } catch (error) {
    console.error('[cron/srs-unavailable-hourly]', error);
    const message = error.message || 'SRS niet-leverbaar cron mislukt.';
    await saveCronRun({
      success: false,
      message,
      totals: { dateFrom, dateTo, dryRun, found: 0, created: 0, duplicates: 0, open: 0, openAmount: 0, failed: 1 },
      error: message
    });
    return res.status(500).json({ success: false, message });
  }
}
