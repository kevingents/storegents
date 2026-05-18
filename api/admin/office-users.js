/**
 * GET   /api/admin/office-users          — lijst alle kantoor-gebruikers
 * POST  /api/admin/office-users          — upsert {name, email, phone, department, active}
 * DELETE /api/admin/office-users?userId=… — verwijderen
 */

import { getAllOfficeUsers, upsertOfficeUser, deleteOfficeUser, makeOfficeUserId } from '../../lib/office-users-store.js';
import { deleteUserPermissions } from '../../lib/user-permissions-store.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';
import { requireSystemAdmin } from '../../lib/permission-guards.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireSystemAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const all = await getAllOfficeUsers();
      const rows = Object.values(all).sort((a, b) => String(a.name).localeCompare(String(b.name), 'nl'));
      return res.status(200).json({ success: true, count: rows.length, users: rows });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const actor = String(req.headers['x-actor'] || body.actor || 'admin').trim() || 'admin';

      if (!body.email) return res.status(400).json({ success: false, message: 'email is verplicht.' });
      if (!body.name) return res.status(400).json({ success: false, message: 'name is verplicht.' });

      const updated = await upsertOfficeUser(body, actor);
      await appendAuditEntry({
        actor,
        action: 'upsert-office-user',
        targetUserId: updated.userId,
        targetName: updated.name,
        after: updated
      });
      return res.status(200).json({ success: true, user: updated });
    }

    if (req.method === 'DELETE') {
      const userId = String(req.query.userId || '').trim();
      if (!userId) return res.status(400).json({ success: false, message: 'userId is verplicht.' });
      const actor = String(req.headers['x-actor'] || 'admin').trim() || 'admin';
      const removed = await deleteOfficeUser(userId);
      /* Ook de permission-override opruimen */
      await deleteUserPermissions(userId).catch(() => {});
      if (removed) {
        await appendAuditEntry({
          actor,
          action: 'delete-office-user',
          targetUserId: userId,
          targetName: '',
          note: 'Office user + permissions verwijderd'
        });
      }
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/office-users]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
