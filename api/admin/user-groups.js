import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  listGroups,
  getGroup,
  upsertGroup,
  deleteGroup,
  addMember,
  removeMember
} from '../../lib/user-groups-store.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * GET    /api/admin/user-groups            → { success, groups: [...] }
 * GET    /api/admin/user-groups?key=X      → { success, group }
 * POST   /api/admin/user-groups            → upsert { key?, name, description?, color?, icon?, memberIds[], mailRecipients[] }
 * POST   /api/admin/user-groups?action=add-member    → { key, userId }
 * POST   /api/admin/user-groups?action=remove-member → { key, userId }
 * DELETE /api/admin/user-groups?key=X      → verwijder group
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
        const group = await getGroup(key);
        if (!group) return res.status(404).json({ success: false, message: 'Group niet gevonden.' });
        return res.status(200).json({ success: true, group });
      }
      const groups = await listGroups();
      return res.status(200).json({ success: true, groups });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const actor = clean(req.headers['x-actor'] || body.actor || 'admin') || 'admin';
      const action = clean(req.query.action);

      if (action === 'add-member') {
        const { key, userId } = body;
        if (!key || !userId) return res.status(400).json({ success: false, message: 'key + userId verplicht.' });
        const before = await getGroup(key);
        const updated = await addMember(key, userId, actor);
        await appendAuditEntry({
          actor, action: 'group-add-member', targetUserId: userId, targetName: before?.name || key,
          note: `Toegevoegd aan group "${before?.name || key}"`, request: req
        }).catch(() => {});
        return res.status(200).json({ success: true, group: updated });
      }

      if (action === 'remove-member') {
        const { key, userId } = body;
        if (!key || !userId) return res.status(400).json({ success: false, message: 'key + userId verplicht.' });
        const before = await getGroup(key);
        const updated = await removeMember(key, userId, actor);
        await appendAuditEntry({
          actor, action: 'group-remove-member', targetUserId: userId, targetName: before?.name || key,
          note: `Verwijderd uit group "${before?.name || key}"`, request: req
        }).catch(() => {});
        return res.status(200).json({ success: true, group: updated });
      }

      /* Upsert */
      if (!body.name) return res.status(400).json({ success: false, message: 'name is verplicht.' });
      const before = body.key ? await getGroup(body.key) : null;
      const updated = await upsertGroup(body, actor);
      await appendAuditEntry({
        actor, action: before ? 'group-update' : 'group-create',
        targetUserId: updated.key, targetName: updated.name,
        before, after: updated, request: req
      }).catch(() => {});
      return res.status(200).json({ success: true, group: updated });
    }

    if (req.method === 'DELETE') {
      const key = clean(req.query.key);
      if (!key) return res.status(400).json({ success: false, message: 'key ontbreekt.' });
      const actor = clean(req.headers['x-actor'] || 'admin') || 'admin';
      const before = await getGroup(key);
      const removed = await deleteGroup(key);
      if (removed && before) {
        await appendAuditEntry({
          actor, action: 'group-delete', targetUserId: key, targetName: before.name,
          before, note: 'Group verwijderd', request: req
        }).catch(() => {});
      }
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/user-groups]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
