import { setCorsHeaders } from '../../lib/cors.js';
import { findDueSchedules, recordRun } from '../../lib/report-schedules-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

/**
 * Cron: /api/cron/run-report-schedules
 *
 * Draait elke 15 minuten. Checkt welke schedules een nextRun <= now hebben
 * en triggert ze. Voor elke run roept hij intern /api/admin/reports/export
 * aan met format=email, zodat het bestaande rendering- + mail-pad
 * gebruikt wordt.
 *
 * Auth: cron-secret OF admin-token (admin mag handmatig dry-runnen).
 *
 * Vercel-schedule (vercel.json):
 *   { "path": "/api/cron/run-report-schedules", "schedule": "0,15,30,45 * * * *" }
 */

function isAuthorized(req) {
  const cronSecret = String(process.env.CRON_SECRET || '').trim();
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();

  const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-cron-secret'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    auth ||
    ''
  ).trim();

  /* Vercel cron stuurt automatisch Authorization: Bearer <CRON_SECRET> */
  if (cronSecret && (given === cronSecret || auth === cronSecret)) return true;
  if (adminToken && given === adminToken) return true;
  return false;
}

/**
 * Runt één schedule. Wordt ook gebruikt door report-schedules.js voor
 * de "run-now" knop. Daarom geëxporteerd.
 *
 * @param {object} sched   — schedule object
 * @param {object} ctx     — { origin: string, adminToken: string }
 */
export async function runSingleSchedule(sched, ctx = {}) {
  const origin = String(ctx.origin || '').replace(/\/$/, '') || `https://${process.env.VERCEL_URL || ''}`;
  const adminToken = String(ctx.adminToken || process.env.ADMIN_TOKEN || '').trim();

  /* Default rapport-params: periode uit schedule, store-filter indien gezet */
  const params = computeReportParams(sched);

  try {
    /* Mail naar elke recipient apart zodat één bounce niet de hele run faalt */
    const downloadUrls = [];
    let firstError = null;

    for (const recipient of (sched.recipients || [])) {
      try {
        const res = await fetch(`${origin}/api/admin/reports/export`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-admin-token': adminToken
          },
          body: JSON.stringify({
            reportKey: sched.reportKey,
            format: 'email',
            recipient,
            params: {
              ...params,
              scheduleId: sched.id,
              scheduleName: sched.name
            }
          })
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.success) {
          throw new Error(json.message || `HTTP ${res.status}`);
        }
        if (json.downloadUrl) downloadUrls.push(json.downloadUrl);
      } catch (e) {
        if (!firstError) firstError = e.message || String(e);
        console.error(`[run-report-schedules] mail to ${recipient} failed:`, e);
      }
    }

    if (firstError) {
      await recordRun(sched.id, { status: 'error', error: firstError, downloadUrl: downloadUrls[0] || null });
      return { id: sched.id, status: 'error', error: firstError, partial: downloadUrls.length > 0 };
    }
    await recordRun(sched.id, { status: 'ok', error: null, downloadUrl: downloadUrls[0] || null });
    return { id: sched.id, status: 'ok', downloadUrl: downloadUrls[0] || null, recipients: sched.recipients.length };
  } catch (error) {
    await recordRun(sched.id, { status: 'error', error: error.message || String(error) });
    return { id: sched.id, status: 'error', error: error.message || String(error) };
  }
}

/**
 * Map schedule.period → { from, to } strings (YYYY-MM-DD) voor in params.
 * Houden we relatief t.o.v. runtime zodat schedules consistent draaien.
 */
function computeReportParams(sched) {
  const now = new Date();
  const d = (date) => date.toISOString().slice(0, 10);
  let from, to;
  switch (sched.period) {
    case 'today':
      from = d(now); to = d(now);
      break;
    case 'yesterday': {
      const y = new Date(now); y.setUTCDate(y.getUTCDate() - 1);
      from = d(y); to = d(y);
      break;
    }
    case 'week': {
      const f = new Date(now); f.setUTCDate(f.getUTCDate() - 7);
      from = d(f); to = d(now);
      break;
    }
    case 'last-7-days': {
      const f = new Date(now); f.setUTCDate(f.getUTCDate() - 7);
      from = d(f); to = d(now);
      break;
    }
    case 'last-30-days': {
      const f = new Date(now); f.setUTCDate(f.getUTCDate() - 30);
      from = d(f); to = d(now);
      break;
    }
    case 'last-90-days': {
      const f = new Date(now); f.setUTCDate(f.getUTCDate() - 90);
      from = d(f); to = d(now);
      break;
    }
    case 'month': {
      const f = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
      from = d(f); to = d(now);
      break;
    }
    case 'quarter': {
      const q = Math.floor(now.getUTCMonth() / 3);
      const f = new Date(now.getUTCFullYear(), q * 3, 1);
      from = d(f); to = d(now);
      break;
    }
    case 'year': {
      const f = new Date(now.getUTCFullYear(), 0, 1);
      from = d(f); to = d(now);
      break;
    }
    default:
      const f = new Date(now); f.setUTCDate(f.getUTCDate() - 7);
      from = d(f); to = d(now);
  }
  const params = { from, to };
  if (Array.isArray(sched.stores) && sched.stores.length === 1) {
    params.store = sched.stores[0];
  } else if (Array.isArray(sched.stores) && sched.stores.length > 1) {
    params.stores = sched.stores;
  }
  if (sched.format && sched.format !== 'csv') params.outputFormat = sched.format;
  return params;
}

async function runHandler(req, res) {
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet geautoriseerd.' });
  }

  try {
    const dryRun = String(req.query?.dryRun || '') === '1';
    const due = await findDueSchedules(new Date());

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        dueCount: due.length,
        due: due.map((s) => ({ id: s.id, name: s.name, nextRun: s.nextRun }))
      });
    }

    const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || ''}`;
    const adminToken = String(process.env.ADMIN_TOKEN || '').trim();

    const results = [];
    for (const sched of due) {
      const r = await runSingleSchedule(sched, { origin, adminToken });
      results.push(r);
    }

    return res.status(200).json({
      success: true,
      ranAt: new Date().toISOString(),
      dueCount: due.length,
      results
    });
  } catch (error) {
    console.error('[run-report-schedules]', error);
    return res.status(500).json({ success: false, message: error.message || 'Fout tijdens cron-run.' });
  }
}

export default trackedCron('run-report-schedules', runHandler);
