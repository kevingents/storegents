/**
 * GET  /api/admin/role-permissions — overzicht roles + permission catalog + matrix
 * POST /api/admin/role-permissions — update een specifieke role.permission toggle
 *   body: { roleKey: 'medewerker', permKey: 'page.x', enabled: true, actor: {...} }
 * POST /api/admin/role-permissions?bulk=1 — bulk updates
 *   body: { changes: [{ roleKey, permKey, enabled }], actor: {...} }
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  readRolePermissions,
  writeRolePermissions,
  buildPermissionMatrix,
  buildUiSections,
  setRolePermission,
  countActivePermissions,
  resolveRolePermissions
} from '../../lib/role-permissions-store.js';
import { ROLES, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from '../../lib/user-roles.js';
import { appendAuditEntry, getAuditLog } from '../../lib/permissions-audit-store.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).trim();
  return token && token === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet geautoriseerd. Geef x-admin-token of adminToken-querystring mee.' });
  }

  try {
    if (req.method === 'GET') {
      const state = await readRolePermissions();
      const matrix = buildPermissionMatrix(state);
      const sections = buildUiSections();

      const rolesWithCounts = ROLES.map((r) => {
        const counts = countActivePermissions(state, r.key);
        const isAdmin = r.key === 'admin';
        const riskLevel = state.riskLevels?.[r.key] || (isAdmin ? 'critical' : counts.total > 15 ? 'high' : counts.total > 8 ? 'medium' : 'low');
        return {
          ...r,
          ...((state.metadata?.[r.key]) || {}),
          activeRights: counts.total,
          byCategory: counts.byCategory,
          riskLevel
        };
      });

      /* Recent audit entries voor "Laatste wijzigingen" widget */
      let recentAudit = [];
      try {
        const entries = await getAuditLog({ limit: 10 });
        recentAudit = Array.isArray(entries) ? entries.slice(0, 10) : [];
      } catch { /* audit-store kan nog leeg zijn */ }

      return res.status(200).json({
        success: true,
        roles: rolesWithCounts,
        permissions: PERMISSIONS,
        sections,
        matrix,
        defaults: ROLE_DEFAULT_PERMISSIONS,
        overrides: state.overrides,
        updatedAt: state.updatedAt,
        updatedBy: state.updatedBy,
        recentAudit
      });
    }

    if (req.method === 'POST') {
      const body = req.body || {};
      const actor = body.actor || { name: 'admin' };
      const isBulk = String(req.query.bulk || '0') === '1' || Array.isArray(body.changes);

      let state = await readRolePermissions();
      const auditEntries = [];

      if (isBulk) {
        const changes = body.changes || [];
        for (const ch of changes) {
          if (!ch?.roleKey || !ch?.permKey) continue;
          const before = resolveRolePermissions(ch.roleKey, state).includes(ch.permKey);
          state = setRolePermission(state, ch.roleKey, ch.permKey, !!ch.enabled);
          if (before !== !!ch.enabled) {
            auditEntries.push({
              roleKey: ch.roleKey, permKey: ch.permKey,
              from: before, to: !!ch.enabled,
              actor, timestamp: new Date().toISOString()
            });
          }
        }
      } else {
        const { roleKey, permKey, enabled } = body;
        if (!roleKey || !permKey) {
          return res.status(400).json({ success: false, message: 'roleKey en permKey verplicht.' });
        }
        const before = resolveRolePermissions(roleKey, state).includes(permKey);
        state = setRolePermission(state, roleKey, permKey, !!enabled);
        if (before !== !!enabled) {
          auditEntries.push({
            roleKey, permKey,
            from: before, to: !!enabled,
            actor, timestamp: new Date().toISOString()
          });
        }
      }

      const saved = await writeRolePermissions(state, actor);

      /* Schrijf elke verandering naar audit log */
      for (const entry of auditEntries) {
        try {
          await appendAuditEntry({
            type: 'role-permission-change',
            roleKey: entry.roleKey,
            permKey: entry.permKey,
            change: entry.from ? 'revoked' : 'granted',
            actor: entry.actor,
            timestamp: entry.timestamp
          });
        } catch (e) {
          console.warn('[role-permissions] audit log write failed:', e.message);
        }
      }

      return res.status(200).json({
        success: true,
        savedAt: saved.updatedAt,
        savedBy: saved.updatedBy,
        changes: auditEntries.length,
        overrides: saved.overrides
      });
    }

    return res.status(405).json({ success: false, message: 'Method not allowed.' });
  } catch (error) {
    console.error('[role-permissions]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onbekende fout.' });
  }
}
