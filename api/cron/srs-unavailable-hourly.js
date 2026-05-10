import { syncGlobalUnavailableOrderLines } from '../../lib/srs-unavailable-global-sync-service.js';
import { listUnavailableOrderLines } from '../../lib/unavailable-order-line-service.js';
import { appendUnavailableCronRun } from '../../lib/unavailable-cron-state-store.js';

function clean(value) {
  return String(value || '').trim();
}

function isAuthorizedCron(req) {
  const expected = clean(process.env.CRON_SECRET || '');
  const authHeader = clean(req.headers['author' + 'ization'] || '');
  const querySecret = clean(req.query.secret || '');
  const userAgent = clean(req.headers['user-agent'] || '');

  if (!expected) return userAgent.includes('vercel-cron/1.0');
  return authHeader === `Bearer ${expected}` || querySecret === expected;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'ja'].includes(clean(value).toLowerCase());
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function buildTotals({ sync = {}, open = {}, dateFrom = '', dateTo = '', dryRun = false } = {}) {
  return {
    dateFrom,
    dateTo,
    dryRun,
    found: Number(sync.found || 0),
    created: Number(sync.created || 0),
    duplicates: Number(sync.duplicates || 0),
    skippedByDate: Number(sync.skippedByDate || 0),
    skippedByLimit: Number(sync.skippedByLimit || 0),
    open: Number(open.rows?.length || 0),
    openAmount: Number(open.totals?.amount || 0),
    openRefundPending: Number(open.totals?.refundPending || 0),
    openSrsCancelPending: Number(open.totals?.srsCancelPending || 0),
    failed: Number(open.totals?.failed || 0),
    runtimeMs: Number(sync.runtimeMs || 0)
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

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd voor cron.' });
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
    dryRun = truthy(req.query.dryRun || process.env.SRS_UNAVAILABLE_CRON_DRY_RUN || '');

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

    const message = `Niet-leverbaar cron klaar. ${sync.created || 0} nieuw, ${sync.duplicates || 0} al bekend. ${open.rows.length} open regel(s).`;
    const totals = buildTotals({ sync, open, dateFrom, dateTo, dryRun });
    const cronState = await saveCronRun({
      success: true,
      message,
      totals,
      syncSummary: {
        source: sync.source || '',
        found: sync.found || 0,
        created: sync.created || 0,
        duplicates: sync.duplicates || 0,
        partial: Boolean(sync.partial),
        errors: Array.isArray(sync.errors) ? sync.errors.slice(0, 10) : []
      }
    });

    return res.status(200).json({
      success: true,
      mode: 'srs_unavailable_hourly_cron',
      dateFrom,
      dateTo,
      dryRun,
      sync,
      openTotals: open.totals,
      openCount: open.rows.length,
      openPreview: open.rows.slice(0, Number(req.query.previewLimit || 25)),
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
