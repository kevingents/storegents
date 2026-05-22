import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  listTemplates,
  getTemplate,
  upsertTemplate,
  deleteTemplate
} from '../../lib/function-templates-store.js';
import { getUserPermissions, upsertUserPermissions } from '../../lib/user-permissions-store.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * GET    /api/admin/function-templates            → { success, templates: [...] }
 * GET    /api/admin/function-templates?key=X      → { success, template }
 * POST   /api/admin/function-templates            → upsert { key?, name, description?, role?, stores[], afdelingen[], extraPermissions[], revokedPermissions[], color?, icon? }
 * POST   /api/admin/function-templates?action=apply → { key, userId } — pas sjabloon toe op gebruiker (merge)
 * DELETE /api/admin/function-templates?key=X      → verwijder sjabloon
 */

function parseBody(req) {
  if (!req.body) return {};
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
      const key = clean(req.query.key);
      if (key) {
        const template = await getTemplate(key);
        if (!template) return res.status(404).json({ success: false, message: 'Sjabloon niet gevonden.' });
        return res.status(200).json({ success: true, template });
      }
      const templates = await listTemplates();
      return res.status(200).json({ success: true, templates });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const actor = clean(req.headers['x-actor'] || body.actor || 'admin') || 'admin';
      const action = clean(req.query.action);

      if (action === 'apply') {
        /* Past het sjabloon toe op één gebruiker (merge-semantiek):
           role wordt gezet als sjabloon een role heeft,
           stores/afdelingen/extraPermissions worden uitgebreid (nooit verwijderd),
           revokedPermissions wordt gezet als opgegeven in sjabloon. */
        const { key, userId } = body;
        if (!key || !userId) return res.status(400).json({ success: false, message: 'key + userId verplicht.' });
        const template = await getTemplate(key);
        if (!template) return res.status(404).json({ success: false, message: 'Sjabloon niet gevonden.' });

        const uid = clean(userId);
        const cur = await getUserPermissions(uid);
        const mergedStores = [...new Set([...(cur?.allowedStoresOverride || []), ...(template.stores || [])])];
        const mergedAfds = [...new Set([...(cur?.afdelingen || []), ...(template.afdelingen || [])])];
        const mergedExtra = [...new Set([...(cur?.extraPermissions || []), ...(template.extraPermissions || [])])];

        const updated = await upsertUserPermissions(uid, {
          ...(template.role ? { role: template.role } : {}),
          allowedStoresOverride: mergedStores,
          afdelingen: mergedAfds,
          afdeling: mergedAfds[0] || (cur?.afdeling || ''),
          extraPermissions: mergedExtra,
          ...(Array.isArray(template.revokedPermissions) && template.revokedPermissions.length
            ? { revokedPermissions: template.revokedPermissions }
            : {})
        }, actor);

        await appendAuditEntry({
          actor,
          action: 'function-template-apply',
          targetUserId: uid,
          targetName: template.name,
          note: `Sjabloon "${template.name}" toegepast`,
          request: req
        }).catch(() => {});

        return res.status(200).json({ success: true, user: updated });
      }

      /* Upsert sjabloon */
      if (!body.name) return res.status(400).json({ success: false, message: 'name is verplicht.' });
      const before = body.key ? await getTemplate(body.key) : null;
      const updated = await upsertTemplate(body, actor);
      await appendAuditEntry({
        actor,
        action: before ? 'function-template-update' : 'function-template-create',
        targetUserId: updated.key,
        targetName: updated.name,
        before,
        after: updated,
        request: req
      }).catch(() => {});
      return res.status(200).json({ success: true, template: updated });
    }

    if (req.method === 'DELETE') {
      const key = clean(req.query.key);
      if (!key) return res.status(400).json({ success: false, message: 'key ontbreekt.' });
      const actor = clean(req.headers['x-actor'] || 'admin') || 'admin';
      const before = await getTemplate(key);
      const removed = await deleteTemplate(key);
      if (removed && before) {
        await appendAuditEntry({
          actor,
          action: 'function-template-delete',
          targetUserId: key,
          targetName: before.name,
          before,
          note: 'Sjabloon verwijderd',
          request: req
        }).catch(() => {});
      }
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/function-templates]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
