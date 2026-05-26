/**
 * Migratie-helpers: zet departments-driven access om naar permissions-driven.
 *
 * De portal staat van oudsher toegang toe op basis van `role` + `department`
 * (of de multi-array `afdelingen`). Voortaan willen we permissions-driven:
 * per gebruiker een set rechten (page.* / action.* / data.*) die expliciet
 * bepaalt wat 'ie ziet en mag.
 *
 * Deze module berekent per gebruiker WELKE rechten erbij komen als we de
 * department-mapping uitvoeren, en kan de mutatie ook uitvoeren (apply=true)
 * of een diff teruggeven (dry-run).
 *
 * Niet-destructief: bestaande extraPermissions/revokedPermissions blijven
 * staan; we voegen alleen toe.
 */

import {
  getAllUserPermissions,
  getUserPermissions,
  upsertUserPermissions
} from './user-permissions-store.js';
import {
  permissionsForDepartment,
  listDepartmentMappings
} from './department-permissions-mapping.js';
import { isValidPermission } from './user-roles.js';

/**
 * Bouw een dry-run diff per gebruiker. Returnt geen mutaties.
 *
 * @returns {{
 *   users: Array<{
 *     personnelId, name, role, department,
 *     currentExtras: string[],
 *     mappingExtras: string[],
 *     toAdd: string[],       // permissions die we toevoegen
 *     alreadyHad: string[],  // permissions uit mapping die al in currentExtras zaten
 *     afterCount: number     // totaal aantal extraPermissions na merge
 *   }>,
 *   summary: { totalUsers, usersWithChanges, totalAdded, perDepartment: {...} }
 * }}
 */
export async function computeMigrationDiff({ personnelIds = null } = {}) {
  const all = await getAllUserPermissions({ refresh: true });
  const ids = personnelIds && personnelIds.length
    ? personnelIds.map(String)
    : Object.keys(all);

  const result = {
    users: [],
    summary: {
      totalUsers: ids.length,
      usersWithChanges: 0,
      totalAdded: 0,
      perDepartment: {}
    }
  };

  for (const id of ids) {
    const entry = all[id] || {};
    /* Pak ALLE afdelingen waar deze user lid van is (multi-array support) */
    const depts = Array.isArray(entry.afdelingen) && entry.afdelingen.length
      ? entry.afdelingen
      : (entry.department ? [entry.department] : []);

    /* Mappings cumulatief samenvoegen */
    const mappingExtrasSet = new Set();
    for (const d of depts) {
      for (const p of permissionsForDepartment(d)) {
        if (isValidPermission(p)) mappingExtrasSet.add(p);
      }
    }
    const mappingExtras = Array.from(mappingExtrasSet);
    const currentExtras = Array.isArray(entry.extraPermissions) ? entry.extraPermissions : [];
    const toAdd = mappingExtras.filter((p) => !currentExtras.includes(p));
    const alreadyHad = mappingExtras.filter((p) => currentExtras.includes(p));

    const userDiff = {
      personnelId: id,
      name: entry.name || entry.displayName || '',
      role: entry.role || 'medewerker',
      department: depts.join(', ') || '—',
      currentExtras,
      mappingExtras,
      toAdd,
      alreadyHad,
      afterCount: [...new Set([...currentExtras, ...mappingExtras])].length
    };
    result.users.push(userDiff);

    if (toAdd.length) {
      result.summary.usersWithChanges += 1;
      result.summary.totalAdded += toAdd.length;
      for (const d of depts) {
        result.summary.perDepartment[d] = (result.summary.perDepartment[d] || 0) + toAdd.length;
      }
    }
  }

  return result;
}

/**
 * Voer de migratie uit voor één gebruiker. Returnt before/after diff.
 *
 * @param {string} personnelId
 * @param {object} opts
 * @param {boolean} opts.dryRun
 * @param {string|object} opts.updatedBy
 */
export async function migrateUser(personnelId, { dryRun = true, updatedBy = 'migrate' } = {}) {
  const entry = await getUserPermissions(personnelId);
  if (!entry) return { personnelId, skipped: true, reason: 'no-entry' };

  const depts = Array.isArray(entry.afdelingen) && entry.afdelingen.length
    ? entry.afdelingen
    : (entry.department ? [entry.department] : []);

  const mappingSet = new Set();
  for (const d of depts) {
    for (const p of permissionsForDepartment(d)) {
      if (isValidPermission(p)) mappingSet.add(p);
    }
  }

  const before = Array.isArray(entry.extraPermissions) ? entry.extraPermissions : [];
  const merged = [...new Set([...before, ...mappingSet])];
  const added = merged.filter((p) => !before.includes(p));

  if (!added.length) {
    return { personnelId, skipped: true, reason: 'no-changes', before, after: before };
  }

  if (!dryRun) {
    await upsertUserPermissions(personnelId, {
      extraPermissions: merged
    }, typeof updatedBy === 'string' ? updatedBy : (updatedBy?.name || 'migrate'));
  }

  return {
    personnelId,
    skipped: false,
    department: depts.join(', '),
    before,
    after: merged,
    added,
    applied: !dryRun
  };
}

/**
 * Bulk-migratie: loop alle users (of subset). Bij apply=true wordt elke
 * user die toevoegingen heeft daadwerkelijk geüpdatet.
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun (default true)
 * @param {string[]} [opts.personnelIds]
 * @param {string|object} [opts.updatedBy]
 */
export async function migrateAll({ dryRun = true, personnelIds = null, updatedBy = 'migrate' } = {}) {
  const diff = await computeMigrationDiff({ personnelIds });
  if (dryRun) {
    return {
      dryRun: true,
      ...diff,
      mappingsTable: listDepartmentMappings()
    };
  }

  /* Apply: per user met toAdd > 0 daadwerkelijk schrijven */
  const applied = [];
  const failed = [];
  for (const user of diff.users) {
    if (!user.toAdd.length) continue;
    try {
      const r = await migrateUser(user.personnelId, { dryRun: false, updatedBy });
      applied.push(r);
    } catch (e) {
      failed.push({ personnelId: user.personnelId, error: e.message });
    }
  }
  return {
    dryRun: false,
    summary: diff.summary,
    applied,
    failed,
    mappingsTable: listDepartmentMappings()
  };
}
