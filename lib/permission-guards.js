/**
 * Permission guards voor backend endpoints.
 *
 * Gebruik:
 *   import { requirePermission } from '../../lib/permission-guards.js';
 *   if (await requirePermission(req, res, 'action.refund')) return;
 *
 * - ADMIN_TOKEN (system-wide override) → altijd toegestaan
 * - Anders: identify user via header x-user-id (personnelId of office-user-id)
 *   en check zijn role + extra/revoked permissions.
 *
 * Voor backwards compat blijft de bestaande `requireAdmin` werken voor
 * endpoints die geen granulair permission-check nodig hebben.
 */

import { getUserPermissions } from './user-permissions-store.js';
import { findOfficeUserByEmail, getAllOfficeUsers } from './office-users-store.js';
import { rolePermissions, resolvePermissions } from './user-roles.js';

function extractAdminToken(req) {
  return String(
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
}

function extractUserId(req) {
  return String(
    req.headers['x-user-id'] ||
    req.query?.userId ||
    req.body?.userId ||
    ''
  ).trim();
}

function extractUserEmail(req) {
  return String(
    req.headers['x-user-email'] ||
    req.query?.userEmail ||
    req.body?.userEmail ||
    ''
  ).trim().toLowerCase();
}

export function isSystemAdmin(req) {
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = extractAdminToken(req);
  return Boolean(expected && given && expected === given);
}

/**
 * Resolve permissions voor de huidige request.
 * Returnt { isSystemAdmin, userId, role, permissions: Set<string>, source }
 */
export async function getCallerPermissions(req) {
  if (isSystemAdmin(req)) {
    /* Systeem-admin (ADMIN_TOKEN) krijgt alle permissies impliciet via 'admin' role */
    return {
      isSystemAdmin: true,
      userId: 'system',
      role: 'admin',
      permissions: new Set(resolvePermissions('admin')),
      source: 'admin-token'
    };
  }

  const userId = extractUserId(req);
  const email = extractUserEmail(req);

  /* Try by userId first (works for both SRS personnelId and office-{slug}) */
  let entry = userId ? await getUserPermissions(userId) : null;

  /* Fallback: try office user by email */
  if (!entry && email) {
    const office = await findOfficeUserByEmail(email);
    if (office) entry = await getUserPermissions(office.userId);
  }

  if (!entry) {
    return {
      isSystemAdmin: false,
      userId: userId || email || '',
      role: 'unknown',
      permissions: new Set(),
      source: 'no-entry'
    };
  }

  const role = entry.role || 'medewerker';
  const perms = resolvePermissions(role, entry.extraPermissions || [], entry.revokedPermissions || []);
  return {
    isSystemAdmin: false,
    userId: entry.personnelId || userId || email,
    role,
    permissions: new Set(perms),
    source: 'permissions-store'
  };
}

/**
 * Guard die request afbreekt met 401/403 als de caller geen permission heeft.
 * Returnt true als er een response is verstuurd (caller moet `return`).
 */
export async function requirePermission(req, res, permissionKey) {
  const ctx = await getCallerPermissions(req);

  if (ctx.isSystemAdmin) return false; /* admin doet alles */
  if (!permissionKey) return false; /* geen check gevraagd */

  if (!ctx.userId || ctx.source === 'no-entry') {
    res.status(401).json({
      success: false,
      message: 'Niet bevoegd — geen valide ADMIN_TOKEN of user-identificatie.',
      code: 'no-auth'
    });
    return true;
  }

  if (!ctx.permissions.has(permissionKey)) {
    res.status(403).json({
      success: false,
      message: `Onvoldoende rechten voor actie "${permissionKey}".`,
      code: 'forbidden',
      role: ctx.role
    });
    return true;
  }

  return false;
}

/**
 * Voor endpoints die alleen voor system-admin (ADMIN_TOKEN) zijn.
 */
export function requireSystemAdmin(req, res) {
  if (isSystemAdmin(req)) return false;
  res.status(401).json({ success: false, message: 'Alleen system-admin (ADMIN_TOKEN).' });
  return true;
}
