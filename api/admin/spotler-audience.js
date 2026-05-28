/**
 * /api/admin/spotler-audience
 *
 * Beheer van de Spotler audience-sync (opt-in klanten → eigen temp-lijst).
 *
 * GET  → { config (slim), lists, lastResult }
 * POST ?action=save-config   { listName?, maxPerRun?, enabled? }
 *      ?action=dry-run       → telt kandidaten, schrijft niets
 *      ?action=test-contact  { email }  → upsert 1 contact (veilige test-write)
 *      ?action=run-now       → echte sync (binnen maxPerRun)
 *
 * Auth: admin-token vereist.
 */

import {
  getAudienceConfig, saveAudienceConfig, listTempLists, runAudienceSync, upsertContact
} from '../../lib/spotler-audience.js';
import { hasSpotlerCreds } from '../../lib/spotler-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function slimConfig(cfg) {
  return {
    enabled: cfg.enabled,
    listId: cfg.listId,
    listName: cfg.listName,
    maxPerRun: cfg.maxPerRun,
    syncedCount: Object.keys(cfg.synced || {}).length,
    lastRun: cfg.lastRun,
    lastResult: cfg.lastResult
  };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (!hasSpotlerCreds()) {
    return res.status(200).json({ success: true, connected: false, message: 'Spotler niet gekoppeld (key/secret ontbreken).' });
  }

  try {
    if (req.method === 'GET') {
      const cfg = await getAudienceConfig();
      const out = { success: true, connected: true, config: slimConfig(cfg) };
      /* Lijsten alleen op verzoek ophalen (live call) — houdt het dashboard snel. */
      if (String(req.query?.lists || '') === '1') out.lists = await listTempLists().catch(() => []);
      return res.status(200).json(out);
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'save-config') {
      const patch = {};
      if (body.listName != null) patch.listName = String(body.listName).slice(0, 120);
      if (body.maxPerRun != null) patch.maxPerRun = Math.max(1, Math.min(2000, Number(body.maxPerRun) || 300));
      if (body.enabled != null) patch.enabled = Boolean(body.enabled);
      const cfg = await saveAudienceConfig(patch);
      return res.status(200).json({ success: true, config: slimConfig(cfg) });
    }

    if (action === 'dry-run') {
      const d = await runAudienceSync({ dryRun: true });
      return res.status(200).json({ success: true, ...d });
    }

    if (action === 'test-contact') {
      const email = String(body.email || '').trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ success: false, message: 'Ongeldig e-mailadres.' });
      await upsertContact(email);
      return res.status(200).json({ success: true, message: `Contact ${email} weggeschreven naar Spotler.` });
    }

    if (action === 'run-now') {
      const d = await runAudienceSync({ dryRun: false });
      return res.status(200).json({ success: true, ...d });
    }

    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/spotler-audience]', e);
    return res.status(500).json({ success: false, message: e.message || 'Audience-sync mislukt.' });
  }
}
