import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  readAllConfigs,
  getConfig,
  upsertConfig,
  deleteConfigOverride,
  listVirtualStores,
  DEFAULT_CONFIGS
} from '../../lib/virtual-store-configs.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * /api/admin/virtual-store-configs
 *
 * GET    → { success, configs, knownKeys, allPages, allModals }
 *           knownKeys = built-in (Finance, Students, Suitconcer)
 *           allPages = page-target lijst voor checkbox-UI (uit DOM via frontend)
 * POST   → upsert config. Body { key, label, defaultPage, allowedPages[], allowedModals[], description, active }
 * DELETE → ?key=X (verwijdert override → terug naar default)
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const configs = await readAllConfigs();
      return res.status(200).json({
        success: true,
        configs,
        knownKeys: Object.keys(DEFAULT_CONFIGS),
        defaults: DEFAULT_CONFIGS
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const actor = clean(req.headers['x-actor'] || body.actor || 'admin') || 'admin';
      if (!body.key) return res.status(400).json({ success: false, message: 'key is verplicht' });
      const before = await getConfig(body.key);
      const updated = await upsertConfig(body);
      await appendAuditEntry({
        actor,
        action: 'update-virtual-store-config',
        targetUserId: updated.key,
        targetName: updated.label || updated.key,
        before,
        after: updated,
        request: req
      }).catch(() => {});
      return res.status(200).json({ success: true, config: updated });
    }

    if (req.method === 'DELETE') {
      const key = clean(req.query.key);
      if (!key) return res.status(400).json({ success: false, message: 'key ontbreekt' });
      const actor = clean(req.headers['x-actor'] || 'admin') || 'admin';
      const before = await getConfig(key);
      const removed = await deleteConfigOverride(key);
      if (removed) {
        await appendAuditEntry({
          actor,
          action: 'reset-virtual-store-config',
          targetUserId: key,
          targetName: before?.label || key,
          before,
          note: 'Override verwijderd — terug naar default',
          request: req
        }).catch(() => {});
      }
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/virtual-store-configs]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
