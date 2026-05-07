import { syncGlobalUnavailableOrderLines } from '../../lib/srs-unavailable-global-sync-service.js';
import { listUnavailableOrderLines } from '../../lib/unavailable-order-line-service.js';
import { appendUnavailableCronRun } from '../../lib/unavailable-cron-state-store.js';

function clean(value) {
  return String(value || '').trim();
}

function isAuthorizedCron(req) {
  const expected = clean(process.env.CRON_SECRET || '');
  const auth = clean(req.headers.authorization || '');
  const querySecret = clean(req.query.secret || '');
  const userAgent = clean(req.headers['user-agent'] || '');

  if (!expected) return userAgent.includes('vercel-cron/1.0');
  return auth === `Bearer ${expected}` || querySecret === expected;
}

function truthy(value) {
  return ['1', 'true', 'yes', 'ja'].includes(clean(value).toLowerCase());
}

function isoDateDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - Number(days || 0));
  return date.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorizedCron(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd voor cron.' });
  }

  const startedAt = Date.now();

  try {
    const daysBack = Number(req.query.daysBack || process.env.SRS_UNAVAILABLE_CRON_DAYS_BACK || 30);
    const dateFrom = clean(req.query.dateFrom || '') || isoDateDaysAgo(daysBack);
    const dateTo = clean(req.query.dateTo || '') || new Date().toISOString().slice(0, 10);
    const maxRuntimeMs = Number(req.query.maxRuntimeMs || process.env.SRS_UNAVAILABLE_CRON_MAX_RUNTIME_MS || 90000);
    const maxRecords = Number(req.query.maxRecords || process.env.SRS_UNAVAILABLE_CRON_MAX_RECORDS || 500);
    const dryRun = truthy(req.query.dryRun || process.env.SRS_UNAVAILABLE_CRON_DRY_RUN || '');

    const sync = await syncGlobalUnavailableOrderLines({
      statuses: 'unavailable,niet leverbaar,not available',
      dateFrom,
      dateTo,
      dryRun,
      maxRuntimeMs,
      maxRecords
    });

    const open = await listUnavailableOrderLines({ status: 'open', dateFrom, dateTo });

    const totals = {
      found: Number(sync.found || 0),
      scanned: Number(sync.scanned || 0),
      created: Number(sync.created || 0),
      duplicates: Number(sync.duplicates || 0),
      errors: Array.isArray(sync.errors) ? sync.errors.length : 0,
      open: open.rows.length,
      openAmount: Math.round(open.rows.reduce((sum, row) => sum + Number(row.amount || 0), 0) * 100) / 100
    };

    const run = {
      success: true,
      mode: 'srs_unavailable_hourly_cron',
      dateFrom,
      dateTo,
      dryRun,
      runtimeMs: Date.now() - startedAt,
      totals,
      message: `Niet-leverbaar cron klaar. ${totals.created} nieuw, ${totals.duplicates} al bekend, ${totals.open} open.`
    };

    await appendUnavailableCronRun(run);

    return res.status(200).json({
      success: true,
      ...run,
      sync,
      openTotals: open.totals,
      openPreview: open.rows.slice(0, Number(req.query.previewLimit || 25))
    });
  } catch (error) {
    const run = {
      success: false,
      mode: 'srs_unavailable_hourly_cron',
      runtimeMs: Date.now() - startedAt,
      totals: { found: 0, scanned: 0, created: 0, duplicates: 0, errors: 1, open: 0, openAmount: 0 },
      message: error.message || 'SRS niet-leverbaar cron mislukt.'
    };
    await appendUnavailableCronRun(run).catch(() => null);
    console.error('[cron/srs-unavailable-hourly]', error);
    return res.status(500).json({ success: false, ...run });
  }
}
