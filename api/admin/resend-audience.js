/**
 * /api/admin/resend-audience
 *
 * Beheer van de Resend audience-sync (opt-in klanten → Resend Audiences, met
 * segmentatie per winkel).
 *
 * GET  → { config (slim), audiences? }   (?audiences=1 voor live lijst)
 * POST ?action=save-config   { mainListName?, storePrefix?, segmentByStore?, maxPerRun?, enabled? }
 *      ?action=dry-run       → telt kandidaten per winkel, schrijft niets
 *      ?action=test-contact  { email, firstName?, lastName? } → 1 contact (veilige test-write)
 *      ?action=run-now       → echte sync (binnen maxPerRun)
 *
 * Auth: admin-token vereist.
 */

import {
  getResendAudienceConfig, saveResendAudienceConfig, listResendAudiences,
  runResendAudienceSync, testResendContact, hasResendKey
} from '../../lib/resend-audience.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 300;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function slimConfig(cfg) {
  return {
    enabled: cfg.enabled,
    segmentByStore: cfg.segmentByStore,
    mainListName: cfg.mainListName,
    storePrefix: cfg.storePrefix,
    maxPerRun: cfg.maxPerRun,
    mainAudienceId: cfg.mainAudienceId || '',
    storeCount: Object.keys(cfg.storeAudiences || {}).length,
    storeAudiences: cfg.storeAudiences || {},
    syncedCount: Object.keys(cfg.synced || {}).length,
    lastRun: cfg.lastRun,
    lastResult: cfg.lastResult
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
      const cfg = await getResendAudienceConfig();
      const out = { success: true, connected: true, config: slimConfig(cfg) };
      if (String(req.query?.audiences || '') === '1') out.audiences = await listResendAudiences().catch(() => []);
      return res.status(200).json(out);
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'save-config') {
      const patch = {};
      if (body.mainListName != null) patch.mainListName = String(body.mainListName).slice(0, 120);
      if (body.storePrefix != null) patch.storePrefix = String(body.storePrefix).slice(0, 40);
      if (body.segmentByStore != null) patch.segmentByStore = Boolean(body.segmentByStore);
      if (body.maxPerRun != null) patch.maxPerRun = Math.max(1, Math.min(1000, Number(body.maxPerRun) || 200));
      if (body.enabled != null) patch.enabled = Boolean(body.enabled);
      const cfg = await saveResendAudienceConfig(patch);
      return res.status(200).json({ success: true, config: slimConfig(cfg) });
    }

    if (action === 'dry-run') {
      const d = await runResendAudienceSync({ dryRun: true });
      return res.status(200).json({ success: true, ...d });
    }

    if (action === 'test-contact') {
      try {
        const d = await testResendContact(String(body.email || ''), { firstName: body.firstName, lastName: body.lastName });
        return res.status(200).json({ success: true, message: `Contact ${d.email} weggeschreven naar de hoofd-audience.`, ...d });
      } catch (e) { return res.status(400).json({ success: false, message: e.message || 'Test mislukt.' }); }
    }

    if (action === 'run-now') {
      const d = await runResendAudienceSync({ dryRun: false });
      return res.status(200).json({ success: true, ...d });
    }

    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/resend-audience]', e);
    return res.status(500).json({ success: false, message: e.message || 'Resend audience-sync mislukt.' });
  }
}
