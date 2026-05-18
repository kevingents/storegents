/**
 * GET /api/me/permissions?userId=...&userEmail=...
 *
 * Returnt de role + effectieve permissies + scope (winkels / regio) voor de
 * huidige gebruiker. Frontend roept dit direct na login en cachet result in
 * localStorage.
 *
 * Auth: ADMIN_TOKEN of valide user-identificatie via header / query.
 *   - x-admin-token (ADMIN_PIN voor admin-gate)
 *   - x-user-id (SRS personnelId of office-{slug})
 *   - x-user-email (alternatief voor office users)
 */

import { getCallerPermissions, isSystemAdmin } from '../../lib/permission-guards.js';
import { ROLES, DEPARTMENTS, PERMISSIONS } from '../../lib/user-roles.js';
import { getUserPermissions } from '../../lib/user-permissions-store.js';
import { findOfficeUserByEmail } from '../../lib/office-users-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const ctx = await getCallerPermissions(req);
    const userId = String(req.query.userId || req.headers['x-user-id'] || ctx.userId || '').trim();
    const email = String(req.query.userEmail || req.headers['x-user-email'] || '').trim().toLowerCase();

    /* System admin (ADMIN_TOKEN) krijgt admin-rol + alle perms */
    if (ctx.isSystemAdmin) {
      return res.status(200).json({
        success: true,
        identity: { userId: 'system', role: 'admin', isSystemAdmin: true },
        permissions: Array.from(ctx.permissions),
        catalog: { roles: ROLES, departments: DEPARTMENTS, permissions: PERMISSIONS }
      });
    }

    if (!userId && !email) {
      return res.status(401).json({ success: false, message: 'Geen user-identificatie meegegeven.' });
    }

    let entry = userId ? await getUserPermissions(userId) : null;
    let officeMeta = null;

    if (!entry && email) {
      officeMeta = await findOfficeUserByEmail(email);
      if (officeMeta) entry = await getUserPermissions(officeMeta.userId);
    }

    /* Geen overrides → default medewerker (eigen winkel) */
    if (!entry) {
      return res.status(200).json({
        success: true,
        identity: { userId, email, role: 'medewerker', isSystemAdmin: false, hasOverride: false },
        permissions: Array.from(ctx.permissions),
        catalog: { roles: ROLES, departments: DEPARTMENTS, permissions: PERMISSIONS }
      });
    }

    return res.status(200).json({
      success: true,
      identity: {
        userId: entry.personnelId || userId || (officeMeta && officeMeta.userId),
        email: email || (officeMeta && officeMeta.email) || '',
        role: entry.role,
        department: entry.department,
        region: entry.region,
        isSystemAdmin: false,
        hasOverride: true,
        snapshot: entry.snapshot || null,
        officeUser: officeMeta || null
      },
      permissions: Array.from(ctx.permissions),
      catalog: { roles: ROLES, departments: DEPARTMENTS, permissions: PERMISSIONS }
    });
  } catch (error) {
    console.error('[me/permissions]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
