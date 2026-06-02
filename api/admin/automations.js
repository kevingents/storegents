/**
 * /api/admin/automations
 *
 * Beheer van alle automations: vaste registry-automations (verjaardag/win-back/
 * replenishment) én door de gebruiker/AI gemaakte custom-automations.
 *
 * GET                       → { automations:[registry], custom:[custom] }
 * POST ?id=&action=save-config { values?/content?/enabled?/maxPerRun?/label? }
 *      ?id=&action=dry-run
 *      ?id=&action=run-now
 *      ?id=&action=reset
 *      ?id=&action=delete         (alleen custom)
 *      ?action=ai-save  { draft:{label,rule,content} }   → custom aanmaken
 *
 * Auth: admin-token vereist. Secret: RESEND_API_KEY (Vercel).
 */

import {
  listAutomationsStatus, getAutomationConfig, saveAutomationConfig, runAutomation, resetAutomation,
  runCustomAutomation, resetCustomAutomation
} from '../../lib/automation-runner.js';
import { AUTOMATIONS } from '../../lib/automations-registry.js';
import {
  createCustomAutomation, patchCustomAutomation, deleteCustomAutomation, getCustomAutomation, validateContent
} from '../../lib/custom-automations-store.js';
import { hasResendKey } from '../../lib/resend-audience.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 300;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}
function coerce(field, val) {
  if (field.type === 'number') { const n = Number(val); const c = Number.isFinite(n) ? n : (field.min ?? 0); return Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, c)); }
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
      const s = await listAutomationsStatus();
      return res.status(200).json({ success: true, connected: true, automations: s.registry, custom: s.custom });
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'ai-save') {
      const d = body.draft || {};
      const obj = await createCustomAutomation({ label: d.label, rule: d.rule, content: d.content });
      return res.status(200).json({ success: true, custom: obj });
    }

    const id = String(req.query?.id || '').trim();
    if (!id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
    const registryDef = AUTOMATIONS[id];

    /* ── Vaste registry-automation ── */
    if (registryDef) {
      if (action === 'save-config') {
        const patch = {};
        if (body.enabled != null) patch.enabled = Boolean(body.enabled);
        const values = body.values || {};
        for (const f of registryDef.fields) if (values[f.key] != null) patch[f.key] = coerce(f, values[f.key]);
        const cfg = await saveAutomationConfig(id, patch);
        const slim = {}; for (const f of registryDef.fields) slim[f.key] = cfg[f.key];
        return res.status(200).json({ success: true, enabled: cfg.enabled, values: slim });
      }
      if (action === 'reset') { await resetAutomation(id); return res.status(200).json({ success: true, message: 'Voortgang gewist.' }); }
      if (action === 'dry-run') return res.status(200).json({ success: true, ...(await runAutomation(id, { dryRun: true })) });
      if (action === 'run-now') return res.status(200).json({ success: true, ...(await runAutomation(id, { dryRun: false })) });
      return res.status(400).json({ success: false, message: 'Onbekende actie.' });
    }

    /* ── Custom-automation ── */
    const custom = await getCustomAutomation(id);
    if (!custom) return res.status(404).json({ success: false, message: 'Automation niet gevonden.' });

    if (action === 'save-config') {
      const patch = {};
      if (body.enabled != null) patch.enabled = Boolean(body.enabled);
      if (body.label != null) patch.label = String(body.label).slice(0, 80);
      if (body.maxPerRun != null) patch.maxPerRun = Math.max(1, Math.min(500, Number(body.maxPerRun) || 80));
      if (body.content != null) patch.content = validateContent(body.content);
      const c = await patchCustomAutomation(id, patch);
      return res.status(200).json({ success: true, custom: c });
    }
    if (action === 'delete') { await deleteCustomAutomation(id); return res.status(200).json({ success: true }); }
    if (action === 'reset') { await resetCustomAutomation(id); return res.status(200).json({ success: true, message: 'Voortgang gewist.' }); }
    if (action === 'dry-run') return res.status(200).json({ success: true, ...(await runCustomAutomation(id, { dryRun: true })) });
    if (action === 'run-now') return res.status(200).json({ success: true, ...(await runCustomAutomation(id, { dryRun: false })) });
    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/automations]', e);
    return res.status(500).json({ success: false, message: e.message || 'Automation mislukt.' });
  }
}
