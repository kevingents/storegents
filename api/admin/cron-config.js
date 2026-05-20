import { handleCors, setCorsHeaders, isAdminRequest } from '../../lib/cors.js';
import {
  KNOWN_CRONS,
  getAllCronConfigs,
  setCronConfig,
  resetCronConfig,
  getEffectiveCronConfig
} from '../../lib/cron-config-store.js';

/**
 * Admin endpoint voor cron-beheer.
 *
 *  GET /api/admin/cron-config
 *    -> { success, crons: [{ key, label, description, defaultSchedule,
 *         defaultLabel, enabled, minIntervalMin, lastRun, lastStatus,
 *         lastDurationMs, lastError, runCount, impact, hasOverride }] }
 *
 *  POST /api/admin/cron-config
 *    Body: { key, enabled?, minIntervalMin? }            -> update 1 cron
 *    Body: { key, action: 'reset' }                       -> reset naar defaults
 *    Body: { updates: { 'key1': {enabled, minIntervalMin}, ... } }  -> bulk
 *
 * LET OP: dit endpoint past ALLEEN de admin-overrides aan in Blob. De
 * Vercel-cron schedule zelf staat in vercel.json en blijft op zijn vaste
 * moment runnen. De cron-handler checkt zelf via cron-guard of de admin
 * 'm heeft uitgezet / vertraagd.
 */

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method === 'GET') {
    try {
      const overrides = await getAllCronConfigs();
      const crons = KNOWN_CRONS.map((c) => {
        const eff = getEffectiveCronConfig(c.key, overrides[c.key]);
        return eff;
      });
      /* Ook crons die wel een override hebben maar niet in KNOWN_CRONS lijst staan */
      for (const [key, override] of Object.entries(overrides || {})) {
        if (!KNOWN_CRONS.find((c) => c.key === key)) {
          crons.push(getEffectiveCronConfig(key, override));
        }
      }
      return res.status(200).json({
        success: true,
        crons,
        knownCount: KNOWN_CRONS.length,
        overrideCount: Object.keys(overrides).length
      });
    } catch (error) {
      console.error('[admin/cron-config] GET error:', error);
      return res.status(500).json({ success: false, message: error.message || 'Kon cron-config niet ophalen.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const updatedBy = String(field(body.updatedBy) || 'admin').trim();

      /* Bulk update */
      if (body.updates && typeof body.updates === 'object') {
        const applied = [];
        for (const [key, patch] of Object.entries(body.updates)) {
          if (!key) continue;
          const clean = {};
          if (typeof patch.enabled === 'boolean') clean.enabled = patch.enabled;
          if (patch.minIntervalMin !== undefined) clean.minIntervalMin = Math.max(0, Number(patch.minIntervalMin) || 0);
          if (Object.keys(clean).length) {
            const r = await setCronConfig(key, clean, updatedBy);
            applied.push(r);
          }
        }
        return res.status(200).json({
          success: true,
          message: `${applied.length} crons bijgewerkt.`,
          applied
        });
      }

      const key = String(field(body.key) || '').trim();
      if (!key) return res.status(400).json({ success: false, message: 'Cron key ontbreekt.' });

      const action = String(field(body.action) || '').toLowerCase();
      if (action === 'reset') {
        const r = await resetCronConfig(key);
        return res.status(200).json({ success: true, message: `Config voor "${key}" gereset.`, ...r });
      }

      const patch = {};
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled;
      if (body.minIntervalMin !== undefined) patch.minIntervalMin = Math.max(0, Number(body.minIntervalMin) || 0);

      if (!Object.keys(patch).length) {
        return res.status(400).json({ success: false, message: 'Geen wijzigingen meegegeven.' });
      }

      const result = await setCronConfig(key, patch, updatedBy);
      return res.status(200).json({
        success: true,
        message: `Cron "${key}" bijgewerkt.`,
        ...result
      });
    } catch (error) {
      console.error('[admin/cron-config] POST error:', error);
      return res.status(400).json({ success: false, message: error.message || 'Kon cron-config niet opslaan.' });
    }
  }

  return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
}
