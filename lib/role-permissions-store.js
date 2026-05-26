/**
 * Role-permissions override store. Bovenop de hardcoded
 * ROLE_DEFAULT_PERMISSIONS in user-roles.js kan een beheerder per rol
 * permissies aan- of uitzetten. Die overrides slaan we hier op zodat de
 * resolved permissie-set wordt gebruikt door isValidPermission-checks.
 *
 * Blob-layout: config/role-permissions.json
 *   {
 *     overrides: {
 *       medewerker: { grants: ['page.x'], revokes: ['action.y'] },
 *       ...
 *     },
 *     riskLevels: { medewerker: 'low', admin: 'critical', ... },
 *     metadata: { ... per-role display tweaks (icon, color, customLabel) }
 *   }
 *
 * Audit-entries worden NIET hier opgeslagen — gebruik
 * permissions-audit-store.js daarvoor (ander Blob-pad).
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { ROLES, PERMISSIONS, ROLE_DEFAULT_PERMISSIONS } from './user-roles.js';

const STORE_PATH = 'config/role-permissions.json';

function emptyState() {
  return {
    overrides: {},
    riskLevels: {},
    metadata: {},
    updatedAt: null,
    updatedBy: null
  };
}

export async function readRolePermissions() {
  const raw = await readJsonBlob(STORE_PATH, emptyState());
  return {
    ...emptyState(),
    ...raw,
    overrides: raw?.overrides || {},
    riskLevels: raw?.riskLevels || {},
    metadata: raw?.metadata || {}
  };
}

export async function writeRolePermissions(state, actor = null) {
  const payload = {
    ...emptyState(),
    ...state,
    overrides: state?.overrides || {},
    riskLevels: state?.riskLevels || {},
    metadata: state?.metadata || {},
    updatedAt: new Date().toISOString(),
    updatedBy: actor ? { name: actor.name || '', id: actor.id || '' } : null
  };
  await writeJsonBlob(STORE_PATH, payload);
  return payload;
}

/**
 * Resolve de effectieve permissie-set voor een rol, na overrides.
 */
export function resolveRolePermissions(roleKey, state) {
  const base = new Set(ROLE_DEFAULT_PERMISSIONS[roleKey] || []);
  const override = state?.overrides?.[roleKey] || {};
  (override.grants || []).forEach((p) => base.add(p));
  (override.revokes || []).forEach((p) => base.delete(p));
  return Array.from(base);
}

/**
 * Bouw een UI-vriendelijke matrix: per rol → { permissionKey: boolean }.
 */
export function buildPermissionMatrix(state) {
  const matrix = {};
  for (const role of ROLES) {
    const effective = new Set(resolveRolePermissions(role.key, state));
    matrix[role.key] = {};
    for (const p of PERMISSIONS) {
      matrix[role.key][p.key] = effective.has(p.key);
    }
  }
  return matrix;
}

/**
 * Update een specifieke permissie voor een rol (toggle aan/uit).
 * Bewaart in state.overrides als minimale delta t.o.v. defaults.
 */
export function setRolePermission(state, roleKey, permKey, enabled) {
  const defaults = new Set(ROLE_DEFAULT_PERMISSIONS[roleKey] || []);
  const isDefault = defaults.has(permKey);

  const overrides = { ...(state.overrides || {}) };
  const current = overrides[roleKey] || { grants: [], revokes: [] };
  const grants = new Set(current.grants || []);
  const revokes = new Set(current.revokes || []);

  if (enabled) {
    /* Wil aan: als niet in default → grant. Verwijder uit revokes als die er staat. */
    revokes.delete(permKey);
    if (!isDefault) grants.add(permKey);
    else grants.delete(permKey); /* default + aan → geen override nodig */
  } else {
    /* Wil uit: als default → revoke. Verwijder uit grants als die er staat. */
    grants.delete(permKey);
    if (isDefault) revokes.add(permKey);
    else revokes.delete(permKey); /* niet-default + uit → geen override nodig */
  }

  overrides[roleKey] = {
    grants: Array.from(grants),
    revokes: Array.from(revokes)
  };

  /* Clean up empty entries */
  if (!overrides[roleKey].grants.length && !overrides[roleKey].revokes.length) {
    delete overrides[roleKey];
  }

  return { ...state, overrides };
}

/**
 * Tel actieve permissies per rol — voor de "12 actieve rechten" donut.
 */
export function countActivePermissions(state, roleKey) {
  const effective = resolveRolePermissions(roleKey, state);
  const byCategory = {};
  for (const permKey of effective) {
    const def = PERMISSIONS.find((p) => p.key === permKey);
    const cat = def?.category || 'Overig';
    byCategory[cat] = (byCategory[cat] || 0) + 1;
  }
  return {
    total: effective.length,
    byCategory
  };
}

/**
 * UI-sectie-meta per categorie (icoon + kleur). Andere categorieën die niet
 * hier zijn opgenomen krijgen een fallback (grijs, package-icoon).
 */
const SECTION_META = {
  'Dagelijks werk':         { icon: 'briefcase',  color: 'blue' },
  'Klanten':                { icon: 'users',      color: 'cyan' },
  'Voorraad & artikelen':   { icon: 'package',    color: 'orange' },
  'Transport':              { icon: 'truck',      color: 'green' },
  'Orders & verkoop':       { icon: 'cart',       color: 'amber' },
  'Finance':                { icon: 'euro',       color: 'purple' },
  'Rapportages & data':     { icon: 'chart',      color: 'amber' },
  'Communicatie':           { icon: 'mail',       color: 'cyan' },
  'Studentenverenigingen':  { icon: 'students',   color: 'indigo' },
  'Suitconcer':             { icon: 'suit',       color: 'purple' },
  'Facilitair':             { icon: 'wrench',     color: 'slate' },
  'WK Poule':               { icon: 'trophy',     color: 'amber' },
  'Beheer':                 { icon: 'shield',     color: 'indigo' },
  'Systeem':                { icon: 'cpu',        color: 'red' },
  'Databereik':             { icon: 'globe',      color: 'slate' }
};

/**
 * Bouw groep-mappings voor de UI matrix dynamisch uit de PERMISSIONS catalog.
 * Iedere unieke `category` wordt een sectie, en alle PERMISSIONS daarin
 * komen erin als rights met leesbaar label.
 */
export function buildUiSections() {
  const byCategory = new Map();
  for (const p of PERMISSIONS) {
    const cat = p.category || 'Overig';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat).push({
      id: p.key,
      label: p.label,
      permKey: p.key,
      kind: p.key.startsWith('action.') ? 'action' : p.key.startsWith('data.') ? 'data' : 'page'
    });
  }
  return Array.from(byCategory.entries()).map(([cat, rights]) => ({
    id: cat.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label: cat,
    icon: SECTION_META[cat]?.icon || 'package',
    color: SECTION_META[cat]?.color || 'slate',
    rights
  }));
}
