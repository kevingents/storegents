/**
 * /api/admin/automation-new-collection
 *
 * Beheer van de slimme automation "nieuwe collectie → eerdere kopers met maat op
 * voorraad" (verstuurd per-winkel via Resend).
 *
 * GET  → { config (slim) }
 * POST ?action=save-config { enabled?, newDays?, lookbackDays?, minStock?, maxPerRun?, maxRecs?, subject? }
 *      ?action=dry-run   → matcht zonder te versturen (telt per winkel)
 *      ?action=run-now   → verstuurt (binnen maxPerRun)
 *      ?action=reset     → wist voortgang/sent (opnieuw kunnen sturen)
 *
 * Auth: admin-token vereist.
 */

import { getNcConfig, saveNcConfig, runNewCollection } from '../../lib/automation-new-collection.js';
import { hasResendKey } from '../../lib/resend-audience.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 300;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function slim(cfg) {
  return {
    enabled: cfg.enabled, newDays: cfg.newDays, lookbackDays: cfg.lookbackDays,
    minStock: cfg.minStock, maxPerRun: cfg.maxPerRun, maxRecs: cfg.maxRecs, subject: cfg.subject,
    processedCount: Object.keys((cfg.processed && cfg.processed.emails) || {}).length,
    sentCount: Object.keys(cfg.sent || {}).length,
    lastRun: cfg.lastRun, lastResult: cfg.lastResult
  };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (!hasResendKey()) {
    return res.status(200).json({ success: true, connected: false, message: 'Resend niet gekoppeld (RESEND_API_KEY ontbreekt).' });
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ success: true, connected: true, config: slim(await getNcConfig()) });
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'save-config') {
      const patch = {};
      if (body.enabled != null) patch.enabled = Boolean(body.enabled);
      if (body.newDays != null) patch.newDays = Math.max(1, Math.min(120, Number(body.newDays) || 21));
      if (body.lookbackDays != null) patch.lookbackDays = Math.max(30, Math.min(1825, Number(body.lookbackDays) || 540));
      if (body.minStock != null) patch.minStock = Math.max(1, Math.min(50, Number(body.minStock) || 1));
      if (body.maxPerRun != null) patch.maxPerRun = Math.max(1, Math.min(500, Number(body.maxPerRun) || 80));
      if (body.maxRecs != null) patch.maxRecs = Math.max(1, Math.min(8, Number(body.maxRecs) || 3));
      if (body.subject != null) patch.subject = String(body.subject).slice(0, 140);
      return res.status(200).json({ success: true, config: slim(await saveNcConfig(patch)) });
    }

    if (action === 'reset') {
      await saveNcConfig({ processed: { key: '', emails: {} }, sent: {} });
      return res.status(200).json({ success: true, message: 'Voortgang gewist — alle klanten komen weer in aanmerking.' });
    }

    if (action === 'dry-run') {
      return res.status(200).json({ success: true, ...(await runNewCollection({ dryRun: true })) });
    }

    if (action === 'run-now') {
      return res.status(200).json({ success: true, ...(await runNewCollection({ dryRun: false })) });
    }

    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/automation-new-collection]', e);
    return res.status(500).json({ success: false, message: e.message || 'Automation mislukt.' });
  }
}
