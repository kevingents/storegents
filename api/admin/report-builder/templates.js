/**
 * /api/admin/report-builder/templates
 *
 * GET    [?viewerEmail=...] → { success, templates: [...] }
 *                              (zonder viewer = alles; met viewer = alleen
 *                               eigenaar + waar viewer is geshared)
 * POST   body { name, source, query, sharedWith? }
 *                              → { success, template }
 * PUT    body { id, ...patch }
 *                              → { success, template }
 *        body { id, action: 'share', email }    → adds share
 *        body { id, action: 'unshare', email }  → removes share
 * DELETE body { id }            → { success, removed: bool }
 *
 * Permissies: alleen eigenaar of admin mag update/delete/share.
 *
 * Auth: admin-token vereist (en x-user-email header voor permissions).
 */

import {
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  shareTemplate
} from '../../../lib/report-builder-templates-store.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function actorFromReq(req) {
  return {
    userId: String(req.headers['x-user-id'] || '').trim(),
    email:  String(req.headers['x-user-email'] || req.body?.actor || 'admin').trim(),
    role:   String(req.headers['x-user-role'] || 'admin').trim()
  };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const viewer = String(req.query?.viewerEmail || '').trim();
      const templates = await listTemplates(viewer || '*');
      return res.status(200).json({ success: true, templates });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const template = await createTemplate({
        name: body.name,
        source: body.source,
        query: body.query,
        sharedWith: body.sharedWith
      }, actorFromReq(req));
      return res.status(200).json({ success: true, template });
    }

    if (req.method === 'PUT') {
      const body = parseBody(req);
      const id = String(body.id || '').trim();
      if (!id) return res.status(400).json({ success: false, message: 'id is verplicht.' });
      const action = String(body.action || '').toLowerCase();

      if (action === 'share' || action === 'unshare') {
        const email = String(body.email || '').trim();
        if (!email) return res.status(400).json({ success: false, message: 'email is verplicht.' });
        const template = await shareTemplate(id, email, action === 'share' ? 'add' : 'remove', actorFromReq(req));
        return res.status(200).json({ success: true, template });
      }

      const template = await updateTemplate(id, body, actorFromReq(req));
      return res.status(200).json({ success: true, template });
    }

    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const id = String(body.id || req.query?.id || '').trim();
      if (!id) return res.status(400).json({ success: false, message: 'id is verplicht.' });
      const removed = await deleteTemplate(id, actorFromReq(req));
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/report-builder/templates]', e);
    const isPermission = /Alleen eigenaar/i.test(e.message || '');
    return res.status(isPermission ? 403 : 500).json({
      success: false,
      message: e.message || 'Onbekende fout.'
    });
  }
}
