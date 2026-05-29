/**
 * Migratie: virtuele winkels (afdelingen) → groepen.
 *
 * De portal werkte voorheen met "virtuele winkels" (Finance, Students,
 * Suitconcer, Supplychain, Marketing) die in de store-switcher stonden en de
 * navigatie filterden op een vaste set allowedPages/allowedModals. Dat model
 * is uitgefaseerd: toegang loopt nu volledig via gebruikers, rollen en groepen.
 *
 * Deze module zet elke afdeling om naar een GROEP:
 *   - groep-key   = afdeling-key in kleine letters (bv. 'supplychain')
 *   - naam        = label uit de virtuele-winkel-config
 *   - accessConfig.extraPermissions = de page-rechten die de afdeling toonde
 *     (allowedPages + allowedModals → page.* , gefilterd op geldige permissies)
 *
 * Daarna worden de huidige afdeling-gebruikers aan die groep gekoppeld
 * (memberIds + user.groups) en — indien gewenst — krijgen ze de bijbehorende
 * permissies als extraPermissions zodat ze exact hun toegang houden in het
 * permission-driven model.
 *
 * Niet-destructief: bestaande permissies/groepen blijven staan; we voegen
 * alleen toe. Idempotent: nogmaals draaien levert "geen wijzigingen" op.
 */

import { readAllConfigs } from './virtual-store-configs.js';
import { getAllUserPermissions, upsertUserPermissions } from './user-permissions-store.js';
import { readAllGroups, upsertGroup } from './user-groups-store.js';
import { isValidPermission } from './user-roles.js';

function clean(v) { return String(v == null ? '' : v).trim(); }
function slugKey(v) {
  return clean(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/* 'Admin' is geen virtuele winkel maar de volledige-toegang-marker — overslaan. */
const SKIP_AFDELINGEN = new Set(['admin']);

/**
 * Leid de page-permissies af die een afdeling-config toonde.
 * allowedPages/allowedModals → 'page.<key>' (alleen geldige permissie-keys).
 */
function permissionsFromConfig(config) {
  const keys = [
    ...(Array.isArray(config?.allowedPages) ? config.allowedPages : []),
    ...(Array.isArray(config?.allowedModals) ? config.allowedModals : [])
  ];
  const set = new Set();
  for (const k of keys) {
    const perm = `page.${clean(k)}`;
    if (isValidPermission(perm)) set.add(perm);
  }
  return Array.from(set);
}

/**
 * Bouw een dry-run diff: per afdeling de afgeleide groep + permissies + de
 * gebruikers die eraan gekoppeld zouden worden. Voert geen mutaties uit.
 */
export async function computeAfdelingGroupDiff() {
  const [configs, allPerms, allGroups] = await Promise.all([
    readAllConfigs(),
    getAllUserPermissions({ refresh: true }),
    readAllGroups()
  ]);

  const afdelingen = [];
  let totalMemberLinks = 0;
  let totalPermGrants = 0;

  for (const [afdKey, config] of Object.entries(configs || {})) {
    if (SKIP_AFDELINGEN.has(slugKey(afdKey))) continue;

    const groupKey = slugKey(afdKey);
    const permissions = permissionsFromConfig(config);
    const existingGroup = allGroups[groupKey] || null;
    const existingMembers = new Set(existingGroup?.memberIds || []);

    /* Gebruikers waarvan afdelingen[] deze afdeling-key bevat */
    const members = [];
    for (const [pid, entry] of Object.entries(allPerms || {})) {
      const userAfds = Array.isArray(entry.afdelingen) && entry.afdelingen.length
        ? entry.afdelingen
        : (entry.afdeling ? [entry.afdeling] : []);
      if (!userAfds.map(clean).includes(clean(afdKey))) continue;

      const currentExtras = Array.isArray(entry.extraPermissions) ? entry.extraPermissions : [];
      const permsToAdd = permissions.filter((p) => !currentExtras.includes(p));
      const alreadyMember = existingMembers.has(pid);

      members.push({
        personnelId: pid,
        name: entry.snapshot?.name || entry.name || '',
        role: entry.role || 'medewerker',
        alreadyMember,
        permsToAdd,
        permsToAddCount: permsToAdd.length
      });
      if (!alreadyMember) totalMemberLinks += 1;
      totalPermGrants += permsToAdd.length;
    }

    afdelingen.push({
      afdeling: afdKey,
      groupKey,
      label: config.label || afdKey,
      description: config.description || '',
      groupExists: Boolean(existingGroup),
      permissions,
      permissionCount: permissions.length,
      memberCount: members.length,
      members
    });
  }

  return {
    afdelingen,
    summary: {
      totalAfdelingen: afdelingen.length,
      totalMembers: afdelingen.reduce((n, a) => n + a.memberCount, 0),
      newMemberLinks: totalMemberLinks,
      totalPermGrants
    }
  };
}

/**
 * Voer de migratie uit (of dry-run).
 *
 * @param {object} opts
 * @param {boolean} opts.dryRun           default true
 * @param {boolean} opts.applyPermissions default true — schrijf de afdelings-
 *                                         rechten als extraPermissions op de
 *                                         gekoppelde gebruikers
 * @param {string|object} opts.updatedBy
 */
export async function migrateAfdelingenToGroups({ dryRun = true, applyPermissions = true, updatedBy = 'migrate' } = {}) {
  const diff = await computeAfdelingGroupDiff();
  const actor = typeof updatedBy === 'string' ? updatedBy : (updatedBy?.name || 'migrate');

  if (dryRun) {
    return { dryRun: true, applyPermissions, ...diff };
  }

  const groupsUpserted = [];
  const usersUpdated = [];
  const failed = [];

  /* Herlees groepen + permissies zodat we op verse data schrijven */
  const [allGroups, allPerms] = await Promise.all([
    readAllGroups(),
    getAllUserPermissions({ refresh: true })
  ]);

  for (const afd of diff.afdelingen) {
    const existing = allGroups[afd.groupKey] || {};
    const memberIds = [...new Set([...(existing.memberIds || []), ...afd.members.map((m) => m.personnelId)])];

    try {
      await upsertGroup({
        key: afd.groupKey,
        name: existing.name || afd.label,
        description: existing.description || afd.description,
        icon: existing.icon || 'users',
        color: existing.color || '#0ea5e9',
        memberIds,
        accessConfig: {
          enabled: true,
          role: existing.accessConfig?.role || '',
          stores: existing.accessConfig?.stores || [],
          afdelingen: [],
          extraPermissions: [...new Set([...(existing.accessConfig?.extraPermissions || []), ...afd.permissions])],
          revokedPermissions: existing.accessConfig?.revokedPermissions || []
        }
      }, actor);
      groupsUpserted.push({ groupKey: afd.groupKey, members: memberIds.length, permissions: afd.permissions.length });
    } catch (e) {
      failed.push({ groupKey: afd.groupKey, error: e.message });
      continue;
    }

    /* Koppel gebruikers: groups[] + (optioneel) extraPermissions */
    for (const m of afd.members) {
      try {
        const entry = allPerms[m.personnelId] || {};
        const groups = [...new Set([...(entry.groups || []), afd.groupKey])];
        const patch = { groups };
        if (applyPermissions) {
          const currentExtras = Array.isArray(entry.extraPermissions) ? entry.extraPermissions : [];
          patch.extraPermissions = [...new Set([...currentExtras, ...afd.permissions])];
        }
        const updated = await upsertUserPermissions(m.personnelId, patch, actor);
        /* houd cache in sync voor volgende afdeling die dezelfde user raakt */
        allPerms[m.personnelId] = updated;
        usersUpdated.push({ personnelId: m.personnelId, groupKey: afd.groupKey, permsAdded: m.permsToAdd.length });
      } catch (e) {
        failed.push({ personnelId: m.personnelId, groupKey: afd.groupKey, error: e.message });
      }
    }
  }

  return {
    dryRun: false,
    applyPermissions,
    summary: diff.summary,
    groupsUpserted,
    usersUpdated,
    failed
  };
}
