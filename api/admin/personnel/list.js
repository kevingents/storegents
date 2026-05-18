/**
 * GET /api/admin/personnel/list
 *
 * Lijst alle SRS personeel + huidige toegekende role/department uit Vercel Blob.
 * Optionele query:
 *   - search: filter op naam / personnelId
 *   - store: filter op gekoppelde winkel
 *   - role: filter op role
 *   - department: filter op afdeling
 *   - includeInactive=1: ook inactieve medewerkers
 */

import { getPersonnel } from '../../../lib/srs-personnel-client.js';
import { getAllUserPermissions } from '../../../lib/user-permissions-store.js';
import { getAllOfficeUsers } from '../../../lib/office-users-store.js';
import { resolvePermissions, ROLES, DEPARTMENTS } from '../../../lib/user-roles.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

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

function matchesSearch(person, search) {
  if (!search) return true;
  const haystack = [
    person.personnelId, person.name, person.internalName, person.externalName
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function matchesStore(person, store) {
  if (!store) return true;
  const lower = store.toLowerCase();
  return (person.stores || []).some((s) => String(s).toLowerCase().includes(lower));
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  const search = String(req.query.search || '').trim();
  const store = String(req.query.store || '').trim();
  const roleFilter = String(req.query.role || '').trim();
  const deptFilter = String(req.query.department || '').trim();
  const includeInactive = String(req.query.includeInactive || '') === '1';

  try {
    /* Widen SRS personnel range tijdelijk via env-vars wanneer kantoor-IDs
       buiten standaardrange vallen. SRS_PERSONNEL_ID_FROM/TO bepalen scope. */
    const srsFrom = String(process.env.SRS_PERSONNEL_ID_FROM || '1').trim();
    const srsTo = String(process.env.SRS_PERSONNEL_ID_TO || '9999').trim();

    const [persons, permsMap, officeUsers] = await Promise.all([
      getPersonnel({ from: srsFrom, to: srsTo }).catch((e) => {
        console.error('[personnel/list] SRS fail:', e.message);
        return [];
      }),
      getAllUserPermissions(),
      getAllOfficeUsers()
    ]);

    const buildPermBlock = (id, snapshot) => {
      const perm = permsMap[String(id)] || null;
      const role = perm?.role || 'medewerker';
      const resolved = resolvePermissions(role, perm?.extraPermissions || [], perm?.revokedPermissions || []);
      return {
        role,
        department: perm?.department || snapshot?.department || '',
        region: perm?.region || '',
        extraPermissions: perm?.extraPermissions || [],
        revokedPermissions: perm?.revokedPermissions || [],
        resolved,
        permissionCount: resolved.length,
        notes: perm?.notes || '',
        hasOverride: Boolean(perm),
        updatedAt: perm?.updatedAt || null,
        updatedBy: perm?.updatedBy || null
      };
    };

    /* SRS personnel rows (winkel-medewerkers met kassa-login) */
    const srsRows = (persons || [])
      .filter((p) => includeInactive || p.active)
      .map((person) => ({
        personnelId: person.personnelId,
        name: person.name,
        internalName: person.internalName,
        externalName: person.externalName,
        email: '',
        phone: '',
        personnelGroupId: person.personnelGroupId,
        active: person.active,
        source: 'srs',
        branches: person.branches,
        stores: person.stores,
        permissions: buildPermBlock(person.personnelId)
      }));

    /* Office users (kantoor zonder kassa-login) */
    const officeRows = Object.values(officeUsers || {})
      .filter((u) => includeInactive || u.active !== false)
      .map((u) => ({
        personnelId: u.userId,
        name: u.name,
        internalName: u.name,
        externalName: u.name,
        email: u.email,
        phone: u.phone || '',
        personnelGroupId: '',
        active: u.active !== false,
        source: 'office',
        branches: [],
        stores: [],
        department: u.department || '',
        permissions: buildPermBlock(u.userId, u)
      }));

    let rows = [...srsRows, ...officeRows];

    /* Filters */
    if (search) rows = rows.filter((r) => matchesSearch(r, search));
    if (store) rows = rows.filter((r) => matchesStore(r, store));
    if (roleFilter) rows = rows.filter((r) => r.permissions.role === roleFilter);
    if (deptFilter) rows = rows.filter((r) => (r.permissions.department || '').toLowerCase() === deptFilter.toLowerCase());

    /* Sort: actief eerst, daarna op naam */
    rows.sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), 'nl');
    });

    /* Aggregaten voor KPI-tegels */
    const totals = {
      total: rows.length,
      active: rows.filter((r) => r.active).length,
      inactive: rows.filter((r) => !r.active).length,
      configured: rows.filter((r) => r.permissions.hasOverride).length,
      srsCount: rows.filter((r) => r.source === 'srs').length,
      officeCount: rows.filter((r) => r.source === 'office').length,
      adminCount: rows.filter((r) => r.permissions.role === 'admin').length,
      regioMgrCount: rows.filter((r) => r.permissions.role === 'regio_manager').length,
      shopMgrCount: rows.filter((r) => r.permissions.role === 'shop_manager').length,
      perRole: ROLES.reduce((acc, r) => {
        acc[r.key] = rows.filter((row) => row.permissions.role === r.key).length;
        return acc;
      }, {})
    };

    return res.status(200).json({
      success: true,
      totals,
      catalog: { roles: ROLES, departments: DEPARTMENTS },
      rows
    });
  } catch (error) {
    console.error('[admin/personnel/list]', error);
    return res.status(500).json({ success: false, message: error.message || 'Personeelslijst kon niet worden opgehaald.' });
  }
}
