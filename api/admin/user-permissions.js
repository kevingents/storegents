/**
 * GET  /api/admin/user-permissions             — Volledig overzicht + catalog
 * GET  /api/admin/user-permissions?personnelId — Eén gebruiker
 * POST /api/admin/user-permissions             — Upsert {personnelId, role, department, extraPermissions, revokedPermissions, notes}
 * POST /api/admin/user-permissions?bulk=1      — Bulk-upsert {items: [...]}
 * DELETE /api/admin/user-permissions?personnelId — Reset naar default (verwijder override)
 */

import {
  getAllUserPermissions,
  getUserPermissions,
  upsertUserPermissions,
  deleteUserPermissions,
  bulkUpsert
} from '../../lib/user-permissions-store.js';
import { ROLES, DEPARTMENTS, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS, resolvePermissions, isValidPermission } from '../../lib/user-roles.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    req.query?.token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function validatePatch(patch) {
  const errors = [];
  if (patch.role && !ROLES.find((r) => r.key === patch.role)) {
    errors.push(`Onbekende role: ${patch.role}`);
  }
  if (Array.isArray(patch.extraPermissions)) {
    patch.extraPermissions.forEach((p) => {
      if (!isValidPermission(p)) errors.push(`Onbekende permission: ${p}`);
    });
  }
  if (Array.isArray(patch.revokedPermissions)) {
    patch.revokedPermissions.forEach((p) => {
      if (!isValidPermission(p)) errors.push(`Onbekende permission (revoke): ${p}`);
    });
  }
  return errors;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  try {
    if (req.method === 'GET') {
      const personnelId = String(req.query.personnelId || '').trim();
      if (personnelId) {
        const entry = await getUserPermissions(personnelId);
        const role = entry?.role || 'medewerker';
        return res.status(200).json({
          success: true,
          entry: entry || { personnelId, role: 'medewerker', extraPermissions: [], revokedPermissions: [] },
          resolved: resolvePermissions(role, entry?.extraPermissions || [], entry?.revokedPermissions || []),
          catalog: { roles: ROLES, departments: DEPARTMENTS, permissions: PERMISSIONS, defaults: ROLE_DEFAULT_PERMISSIONS }
        });
      }
      const all = await getAllUserPermissions();
      return res.status(200).json({
        success: true,
        entries: all,
        catalog: { roles: ROLES, departments: DEPARTMENTS, permissions: PERMISSIONS, defaults: ROLE_DEFAULT_PERMISSIONS }
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const bulkMode = String(req.query.bulk || '') === '1';
      const updatedBy = String(req.headers['x-actor'] || body.actor || 'admin').trim() || 'admin';

      if (bulkMode) {
        const items = Array.isArray(body.items) ? body.items : [];
        const errors = items.flatMap((it) => validatePatch(it).map((m) => `[${it.personnelId}] ${m}`));
        if (errors.length) return res.status(400).json({ success: false, message: 'Ongeldige invoer.', errors });
        const count = await bulkUpsert(items, updatedBy);
        return res.status(200).json({ success: true, count });
      }

      const personnelId = body.personnelId || req.query.personnelId;
      if (!personnelId) return res.status(400).json({ success: false, message: 'personnelId is verplicht.' });

      const errors = validatePatch(body);
      if (errors.length) return res.status(400).json({ success: false, message: 'Ongeldige invoer.', errors });

      const entry = await upsertUserPermissions(personnelId, body, updatedBy);
      const role = entry.role;
      return res.status(200).json({
        success: true,
        entry,
        resolved: resolvePermissions(role, entry.extraPermissions || [], entry.revokedPermissions || [])
      });
    }

    if (req.method === 'DELETE') {
      const personnelId = String(req.query.personnelId || '').trim();
      if (!personnelId) return res.status(400).json({ success: false, message: 'personnelId is verplicht.' });
      const removed = await deleteUserPermissions(personnelId);
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/user-permissions]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
