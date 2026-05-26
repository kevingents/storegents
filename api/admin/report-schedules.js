import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  recordRun,
  SCHEDULE_LIMITS,
  isAllowedRecipient
} from '../../lib/report-schedules-store.js';
import { getSupportedReportKeys } from '../../lib/report-data-fetchers.js';

/**
 * /api/admin/report-schedules
 *
 * GET    → lijst alle schedules + limits + supported report keys
 * POST   → maak nieuwe schedule  body: { name, reportKey, period, frequency, recipients[], stores[], format, hourUtc, weekday, dayOfMonth, enabled }
 * PUT    → update bestaande schedule  body: { id, ...fields, action? }
 *           action: 'update' (default) | 'delete' | 'enable' | 'disable' | 'run-now'
 *
 * Beveiligd met admin-token (requireAdmin).
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'PUT', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'PUT', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const schedules = await listSchedules();
      let supportedReports = [];
      try { supportedReports = getSupportedReportKeys(); } catch (e) { /* niet beschikbaar */ }
      return res.status(200).json({
        success: true,
        schedules,
        limits: SCHEDULE_LIMITS,
        supportedReports
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const sched = await createSchedule(body);
      return res.status(200).json({ success: true, schedule: sched });
    }

    if (req.method === 'PUT') {
      const body = parseBody(req);
      const id = String(body?.id || '').trim();
      const action = String(body?.action || 'update').toLowerCase();
      if (!id) return res.status(400).json({ success: false, message: 'id is verplicht.' });

      if (action === 'delete') {
        await deleteSchedule(id);
        return res.status(200).json({ success: true, deleted: id });
      }

      if (action === 'enable' || action === 'disable') {
        const sched = await updateSchedule(id, { enabled: action === 'enable' });
        return res.status(200).json({ success: true, schedule: sched });
      }

      if (action === 'run-now') {
        /* Trigger direct via interne call naar de cron-runner — daarmee
           hergebruiken we exact dezelfde flow. */
        const runRes = await runScheduleNow(id, req);
        return res.status(200).json({ success: true, ranNow: runRes });
      }

      /* Standaard update */
      const sched = await updateSchedule(id, body);
      return res.status(200).json({ success: true, schedule: sched });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[report-schedules]', error);
    return res.status(400).json({ success: false, message: error.message || 'Onbekende fout.' });
  }
}

/**
 * Trigger één schedule direct (zonder te wachten op cron). Importeert de
 * cron-runner-helper zodat de logica niet wordt gedupliceerd.
 */
async function runScheduleNow(id, req) {
  const { runSingleSchedule } = await import('../cron/run-report-schedules.js');
  const { listSchedules } = await import('../../lib/report-schedules-store.js');
  const list = await listSchedules();
  const sched = list.find((s) => s.id === id);
  if (!sched) throw new Error('Schedule niet gevonden.');
  const origin = `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host || ''}`;
  const adminToken = process.env.ADMIN_TOKEN || '';
  return await runSingleSchedule(sched, { origin, adminToken });
}
