import { getUnavailableCronState, appendUnavailableCronRun } from '../../lib/unavailable-cron-state-store.js';

function clean(value) {
  return String(value || '').trim();
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorizedCron(req) {
  const expected = clean(process.env.CRON_SECRET || '');
  const adminToken = clean(process.env.ADMIN_TOKEN || '12345');
  const authHeader = clean(req.headers.authorization || '');
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

function getBackfillRuns(state = {}) {
  return (state.runs || []).filter((run) => run.type === 'srs_cancelled_backfill_2026');
}

function getNextOffset(state = {}) {
  const latest = getBackfillRuns(state)[0];
  return Math.max(0, Number(latest?.nextOffset || 0));
}

function getTotals(state = {}) {
  return getBackfillRuns(state).reduce((acc, run) => {
    acc.created += Number(run.created || 0);
    acc.duplicates += Number(run.duplicates || 0);
    acc.prepared += Number(run.prepared || 0);
    acc.runs += 1;
    return acc;
  }, { created: 0, duplicates: 0, prepared: 0, runs: 0 });
}

async function callBackfill(req, { offset, limit, dryRun }) {
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers.host || process.env.VERCEL_URL || '';
  const adminToken = clean(process.env.ADMIN_TOKEN || '12345');
  if (!host) throw new Error('Host ontbreekt voor interne backfill-call.');

  const url = new URL(`${protocol}://${host}/api/admin/unavailable-order-lines/backfill-cancelled-2026`);
  url.searchParams.set('adminToken', adminToken);
  url.searchParams.set('admin_token', adminToken);
  url.searchParams.set('dateFrom', '2026-01-01');
  url.searchParams.set('dateTo', '2026-12-31');
  url.searchParams.set('maxRecords', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('dryRun', dryRun ? '1' : '0');
  url.searchParams.set('includeDetails', '0');
  url.searchParams.set('statuses', 'cancelled');
  url.searchParams.set('previewLimit', '5');
  url.searchParams.set('t', Date.now());

  const response = await fetch(url.toString(), { cache: 'no-store' });
  const text = await response.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_error) {
    data = { success: false, message: text };
  }
  return { status: response.status, data };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  if (!isAuthorizedCron(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    const state = await getUnavailableCronState();
    const reset = truthy(req.query.reset);
    const dryRun = truthy(req.query.dryRun);
    const limit = Math.max(1, Math.min(100, Number(req.query.limit || req.query.maxRecords || 25)));
    const requestedOffset = req.query.offset !== undefined ? Number(req.query.offset) : null;
    const offset = reset ? 0 : Math.max(0, Number.isFinite(requestedOffset) ? requestedOffset : getNextOffset(state));
    const existingTotals = reset ? { created: 0, duplicates: 0, prepared: 0, runs: 0 } : getTotals(state);

    const { status, data } = await callBackfill(req, { offset, limit, dryRun });
    const nextOffset = Number(data.nextOffset || offset + Number(data.prepared || 0));
    const completed = Boolean(data.hasMore === false || Number(data.prepared || 0) === 0);
    const message = completed
      ? `SRS cancelled backfill 2026 klaar. Offset ${offset}, ${data.created || 0} nieuw, ${data.duplicates || 0} dubbel.`
      : `SRS cancelled backfill 2026 batch klaar. Offset ${offset} -> ${nextOffset}, ${data.created || 0} nieuw, ${data.duplicates || 0} dubbel.`;

    await appendUnavailableCronRun({
      type: 'srs_cancelled_backfill_2026',
      success: status < 400 && data.success !== false,
      completed,
      dryRun,
      offset,
      nextOffset,
      limit,
      found: data.found || 0,
      prepared: data.prepared || 0,
      created: data.created || 0,
      duplicates: data.duplicates || 0,
      totalCreated: existingTotals.created + Number(data.created || 0),
      totalDuplicates: existingTotals.duplicates + Number(data.duplicates || 0),
      errors: data.errors || [],
      preview: data.preview || [],
      message,
      totals: {
        type: 'srs_cancelled_backfill_2026',
        offset,
        nextOffset,
        found: data.found || 0,
        prepared: data.prepared || 0,
        created: data.created || 0,
        duplicates: data.duplicates || 0,
        completed
      }
    });

    return res.status(status < 400 ? 200 : status).json({
      success: status < 400 && data.success !== false,
      mode: 'srs_cancelled_backfill_2026_cron',
      completed,
      dryRun,
      offset,
      nextOffset,
      limit,
      totalsBefore: existingTotals,
      backfill: data,
      message
    });
  } catch (error) {
    console.error('[cron/srs-cancelled-backfill-2026]', error);
    await appendUnavailableCronRun({
      type: 'srs_cancelled_backfill_2026',
      success: false,
      message: error.message || 'SRS cancelled backfill cron mislukt.',
      error: error.message || 'SRS cancelled backfill cron mislukt.'
    });
    return res.status(500).json({ success: false, message: error.message || 'SRS cancelled backfill cron mislukt.' });
  }
}
