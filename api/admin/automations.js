/**
 * /api/admin/automations
 *
 * Beheer van de registry-automations (verjaardag, win-back, replenishment, …).
 *
 * GET                     → { connected, automations: [{id,label,fields,config}] }
 * POST ?id=&action=save-config { values:{...}, enabled? }
 *      ?id=&action=dry-run
 *      ?id=&action=run-now
 *      ?id=&action=reset
 *
 * Auth: admin-token vereist. Secret: RESEND_API_KEY (Vercel).
 */

import { listAutomationsStatus, getAutomationConfig, saveAutomationConfig, runAutomation, resetAutomation } from '../../lib/automation-runner.js';
import { AUTOMATIONS } from '../../lib/automations-registry.js';
import { hasResendKey } from '../../lib/resend-audience.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 300;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

/* Waarde valideren volgens veld-type (clamp getallen, trim tekst). */
function coerce(field, val) {
  if (field.type === 'number') {
    const n = Number(val);
    const clamped = Number.isFinite(n) ? n : (field.min ?? 0);
    return Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, clamped));
  }
  return String(val == null ? '' : val).slice(0, 200);
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (!hasResendKey()) {
    return res.status(200).json({ success: true, connected: false, message: 'Resend niet gekoppeld (RESEND_API_KEY ontbreekt).' });
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ success: true, connected: true, automations: await listAutomationsStatus() });
    }

    const id = String(req.query?.id || '').trim();
    const def = AUTOMATIONS[id];
    if (!def) return res.status(400).json({ success: false, message: 'Onbekende automation.' });
    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'save-config') {
      const patch = {};
      if (body.enabled != null) patch.enabled = Boolean(body.enabled);
      const values = body.values || {};
      for (const f of def.fields) if (values[f.key] != null) patch[f.key] = coerce(f, values[f.key]);
      const cfg = await saveAutomationConfig(id, patch);
      const slim = {}; for (const f of def.fields) slim[f.key] = cfg[f.key];
      return res.status(200).json({ success: true, enabled: cfg.enabled, values: slim });
    }
    if (action === 'reset') {
      await resetAutomation(id);
      return res.status(200).json({ success: true, message: 'Voortgang gewist.' });
    }
    if (action === 'dry-run') {
      return res.status(200).json({ success: true, ...(await runAutomation(id, { dryRun: true })) });
    }
    if (action === 'run-now') {
      return res.status(200).json({ success: true, ...(await runAutomation(id, { dryRun: false })) });
    }
    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/automations]', e);
    return res.status(500).json({ success: false, message: e.message || 'Automation mislukt.' });
  }
}
