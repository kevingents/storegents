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
import { readRolePermissions, getAllRoles } from '../../../lib/role-permissions-store.js';
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
  /* Match op effectieve stores (SRS ∪ override) zodat office-users met
     een toegewezen winkel ook gevonden worden bij filter. */
  const haystack = person.effectiveStores || person.stores || [];
  return haystack.some((s) => String(s).toLowerCase().includes(lower));
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
        afdeling: perm?.afdeling || '',
        region: perm?.region || '',
        extraPermissions: perm?.extraPermissions || [],
        revokedPermissions: perm?.revokedPermissions || [],
        allowedStoresOverride: perm?.allowedStoresOverride || [],
        groups: perm?.groups || [],
        resolved,
        permissionCount: resolved.length,
        notes: perm?.notes || '',
        hasOverride: Boolean(perm),
        updatedAt: perm?.updatedAt || null,
        updatedBy: perm?.updatedBy || null
      };
    };

    /* Bereken effectieve toegestane winkels = SRS-stores ∪ allowedStoresOverride.
       SRS-personeel: SRS-stores zijn de primaire koppeling, override is additief.
       Office-users: hebben geen SRS-stores, dus override = volledige lijst. */
    const computeEffectiveStores = (srsStores, override) => {
      const set = new Set();
      (srsStores || []).forEach((s) => { if (s) set.add(String(s).trim()); });
      (override || []).forEach((s) => { if (s) set.add(String(s).trim()); });
      return [...set].sort((a, b) => a.localeCompare(b, 'nl'));
    };

    /* SRS personnel rows (winkel-medewerkers met kassa-login) */
    const srsRows = (persons || [])
      .filter((p) => includeInactive || p.active)
      .map((person) => {
        const perms = buildPermBlock(person.personnelId);
        return {
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
          effectiveStores: computeEffectiveStores(person.stores, perms.allowedStoresOverride),
          permissions: perms
        };
      });

    /* Office users (kantoor zonder kassa-login) — met account-staat */
    const officeRows = Object.values(officeUsers || {})
      .filter((u) => includeInactive || u.active !== false)
      .map((u) => {
        /* Bepaal account-status voor de UI */
        const hasPassword = Boolean(u.passwordHash);
        const inviteActive = Boolean(u.inviteToken && u.inviteTokenExpiresAt && new Date(u.inviteTokenExpiresAt).getTime() > Date.now());
        const inviteExpired = Boolean(u.inviteToken && u.inviteTokenExpiresAt && new Date(u.inviteTokenExpiresAt).getTime() <= Date.now());
        let accountStatus = 'unknown';
        if (u.active === false) accountStatus = 'inactive';
        else if (hasPassword) accountStatus = 'active';
        else if (inviteActive) accountStatus = 'invited';
        else if (inviteExpired) accountStatus = 'invite-expired';
        else accountStatus = 'no-password';

        const perms = buildPermBlock(u.userId, u);
        return {
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
          effectiveStores: computeEffectiveStores([], perms.allowedStoresOverride),
          department: u.department || '',
          /* Account-staat metadata voor de UI */
          accountStatus,
          hasPassword,
          inviteActive,
          inviteExpired,
          inviteSentAt: u.inviteSentAt || null,
          inviteTokenExpiresAt: u.inviteTokenExpiresAt || null,
          passwordSetAt: u.passwordSetAt || null,
          twoFactorEnabled: u.twoFactorEnabled !== false,
          lastLoginAt: u.twoFactorLastVerifiedAt || u.lastLoginAt || null,
          permissions: perms
        };
      });

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

    /* Catalog-rollen incl. custom rollen (uit role-permissions store) zodat de
       rol-dropdown in gebruikersbeheer ook eigen rollen toont. */
    let catalogRoles = ROLES;
    try { catalogRoles = getAllRoles(await readRolePermissions()); }
    catch (e) { console.warn('[personnel/list] custom rollen niet leesbaar:', e.message); }

    return res.status(200).json({
      success: true,
      totals,
      catalog: { roles: catalogRoles, departments: DEPARTMENTS },
      rows
    });
  } catch (error) {
    console.error('[admin/personnel/list]', error);
    return res.status(500).json({ success: false, message: error.message || 'Personeelslijst kon niet worden opgehaald.' });
  }
}
