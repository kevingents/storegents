/**
 * Admin CRUD voor risky-actions config.
 *
 *   GET    /api/admin/risky-actions-config
 *   POST   /api/admin/risky-actions-config       body: { key, label?, enabled?, threshold?, confirmTtlSeconds? }
 *   DELETE /api/admin/risky-actions-config?key=...
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getRiskyActionsConfig, upsertRiskyAction, removeRiskyAction } from '../../lib/risky-actions-config.js';

export const maxDuration = 15;

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v == null ? '' : v).trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const cfg = await getRiskyActionsConfig({ refresh: true });
      return res.status(200).json({ success: true, actions: cfg.asList, generatedAt: cfg.generatedAt });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const key = clean(body.key);
      if (!key) return res.status(400).json({ success: false, message: 'key verplicht.' });
      const patch = {};
      if (body.label !== undefined) patch.label = clean(body.label);
      if (body.description !== undefined) patch.description = clean(body.description);
      if (body.enabled !== undefined) patch.enabled = !!body.enabled;
      if (body.threshold !== undefined) patch.threshold = body.threshold === null ? null : Number(body.threshold);
      if (body.confirmTtlSeconds !== undefined) patch.confirmTtlSeconds = Math.max(15, Number(body.confirmTtlSeconds) || 60);
      const r = await upsertRiskyAction(key, patch);
      return res.status(200).json({ success: true, ...r });
    }

    if (req.method === 'DELETE') {
      const key = clean(req.query.key);
      if (!key) return res.status(400).json({ success: false, message: 'key verplicht.' });
      const r = await removeRiskyAction(key);
      return res.status(200).json({ success: true, ...r });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/risky-actions-config]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
