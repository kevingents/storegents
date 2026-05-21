import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  readMetricsConfig,
  updateMetricOverride,
  updateGlobalAlertRecipients,
  resetMetricOverride,
  DEFAULT_METRICS
} from '../../lib/supplychain-metrics-config.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * /api/admin/supplychain-metrics-config
 *
 * GET    → { metrics, globalAlertRecipients, defaults }
 * POST   → upsert metric-override: { key, enabled?, label?, thresholds?, alertRecipients? }
 *           óf bulk-alert-recipients: { alertRecipients: [...] }
 * DELETE → ?key=X (reset 1 metric naar default)
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const config = await readMetricsConfig();
      return res.status(200).json({
        success: true,
        ...config,
        defaults: DEFAULT_METRICS
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const actor = String(req.headers['x-actor'] || body.actor || 'admin').trim() || 'admin';

      /* Bulk alert-recipients update */
      if (Array.isArray(body.alertRecipients) && !body.key) {
        const before = await readMetricsConfig();
        const result = await updateGlobalAlertRecipients(body.alertRecipients);
        await appendAuditEntry({
          actor,
          action: 'update-supplychain-alert-recipients',
          targetUserId: 'global',
          before: { recipients: before.globalAlertRecipients },
          after: { recipients: result.globalAlertRecipients },
          request: req
        }).catch(() => {});
        return res.status(200).json({ success: true, ...result, defaults: DEFAULT_METRICS });
      }

      if (!body.key) {
        return res.status(400).json({ success: false, message: 'key ontbreekt' });
      }
      const before = await readMetricsConfig();
      const beforeEntry = before.metrics.find((m) => m.key === body.key) || null;
      const result = await updateMetricOverride(body.key, {
        enabled: body.enabled,
        label: body.label,
        thresholds: body.thresholds,
        alertRecipients: body.alertRecipients
      });
      const afterEntry = result.metrics.find((m) => m.key === body.key) || null;
      await appendAuditEntry({
        actor,
        action: 'update-supplychain-metric',
        targetUserId: body.key,
        targetName: beforeEntry?.label || body.key,
        before: beforeEntry ? { enabled: beforeEntry.enabled, thresholds: beforeEntry.thresholds, alertRecipients: beforeEntry.alertRecipients } : null,
        after: afterEntry ? { enabled: afterEntry.enabled, thresholds: afterEntry.thresholds, alertRecipients: afterEntry.alertRecipients } : null,
        request: req
      }).catch(() => {});
      return res.status(200).json({ success: true, ...result, defaults: DEFAULT_METRICS });
    }

    if (req.method === 'DELETE') {
      const key = String(req.query.key || '').trim();
      if (!key) return res.status(400).json({ success: false, message: 'key ontbreekt' });
      const actor = String(req.headers['x-actor'] || 'admin').trim() || 'admin';
      const removed = await resetMetricOverride(key);
      if (removed) {
        await appendAuditEntry({
          actor,
          action: 'reset-supplychain-metric',
          targetUserId: key,
          note: 'Override verwijderd — terug naar default',
          request: req
        }).catch(() => {});
      }
      const result = await readMetricsConfig();
      return res.status(200).json({ success: true, removed, ...result, defaults: DEFAULT_METRICS });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/supplychain-metrics-config]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Onverwachte fout.'
    });
  }
}
