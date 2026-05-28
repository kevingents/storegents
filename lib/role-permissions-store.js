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

/* Korte in-memory cache: readRolePermissions wordt nu ook door
   getCallerPermissions (permission-guards) aangeroepen op beschermde
   endpoints — zonder cache zou dat per request een blob-read kosten. */
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 15_000;

function emptyState() {
  return {
    overrides: {},
    riskLevels: {},
    metadata: {},
    customRoles: [],
    updatedAt: null,
    updatedBy: null
  };
}

function normalize(raw) {
  return {
    ...emptyState(),
    ...raw,
    overrides: raw?.overrides || {},
    riskLevels: raw?.riskLevels || {},
    metadata: raw?.metadata || {},
    customRoles: Array.isArray(raw?.customRoles) ? raw.customRoles : []
  };
}

export async function readRolePermissions({ refresh = false } = {}) {
  if (!refresh && _cache && (Date.now() - _cacheAt) < CACHE_TTL_MS) return _cache;
  const raw = await readJsonBlob(STORE_PATH, emptyState());
  _cache = normalize(raw);
  _cacheAt = Date.now();
  return _cache;
}

export async function writeRolePermissions(state, actor = null) {
  const payload = {
    ...normalize(state),
    updatedAt: new Date().toISOString(),
    updatedBy: actor ? { name: actor.name || '', id: actor.id || '' } : null
  };
  await writeJsonBlob(STORE_PATH, payload);
  _cache = payload;            /* houd cache vers na een write */
  _cacheAt = Date.now();
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

/* Gereserveerde keys = de hardcoded rollen; custom rollen mogen die niet overschrijven. */
const RESERVED_ROLE_KEYS = new Set(ROLES.map((r) => r.key));

/** Slugify een label naar een veilige rol-key. */
export function slugRoleKey(label) {
  return String(label || '')
    .toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Alle rollen: hardcoded + custom (met isCustom-vlag). */
export function getAllRoles(state) {
  const custom = (state?.customRoles || []).map((r) => ({ ...r, isCustom: true }));
  return [...ROLES.map((r) => ({ ...r, isCustom: false })), ...custom];
}

/** Voeg een custom rol toe. Returnt { state, role } of gooit bij conflict. */
export function addCustomRole(state, { key, label, description = '', color = '#6366f1', copyFromRole = '' } = {}) {
  const s = { ...state, customRoles: Array.isArray(state?.customRoles) ? state.customRoles : [] };
  const roleKey = String(key || '').trim() || slugRoleKey(label);
  if (!String(label || '').trim()) throw new Error('Rol-naam (label) is verplicht.');
  if (!roleKey) throw new Error('Kon geen geldige sleutel afleiden uit de naam.');
  if (RESERVED_ROLE_KEYS.has(roleKey)) throw new Error(`"${roleKey}" is een vaste rol — kies een andere naam.`);
  if (s.customRoles.some((r) => r.key === roleKey)) throw new Error(`Rol "${roleKey}" bestaat al.`);

  const role = {
    key: roleKey,
    label: String(label).trim(),
    description: String(description || '').trim(),
    color: String(color || '#6366f1').trim(),
    createdAt: new Date().toISOString()
  };
  s.customRoles = [...s.customRoles, role];

  /* Kopieer rechten van een bestaande rol → opslaan als grants. Custom rollen
     hebben geen hardcoded default, dus grants = de volledige effectieve set. */
  if (copyFromRole) {
    const copied = resolveRolePermissions(copyFromRole, s);
    s.overrides = { ...(s.overrides || {}), [roleKey]: { grants: copied, revokes: [] } };
  }
  return { state: s, role };
}

/** Werk label / omschrijving / kleur van een custom rol bij. */
export function updateCustomRole(state, key, patch = {}) {
  const list = Array.isArray(state?.customRoles) ? state.customRoles : [];
  const idx = list.findIndex((r) => r.key === key);
  if (idx === -1) throw new Error(`Custom rol "${key}" niet gevonden.`);
  const next = [...list];
  next[idx] = {
    ...list[idx],
    label: patch.label != null ? String(patch.label).trim() : list[idx].label,
    description: patch.description != null ? String(patch.description).trim() : list[idx].description,
    color: patch.color != null ? String(patch.color).trim() : list[idx].color,
    updatedAt: new Date().toISOString()
  };
  return { state: { ...state, customRoles: next }, role: next[idx] };
}

/** Verwijder een custom rol + bijbehorende overrides/risk/metadata. */
export function deleteCustomRole(state, key) {
  if (RESERVED_ROLE_KEYS.has(key)) throw new Error('Vaste rollen kunnen niet verwijderd worden.');
  const s = { ...state };
  s.customRoles = (Array.isArray(state?.customRoles) ? state.customRoles : []).filter((r) => r.key !== key);
  const drop = (obj) => { if (obj && obj[key] != null) { const c = { ...obj }; delete c[key]; return c; } return obj; };
  s.overrides = drop(s.overrides);
  s.riskLevels = drop(s.riskLevels);
  s.metadata = drop(s.metadata);
  return { state: s };
}

/**
 * Bouw een UI-vriendelijke matrix: per rol → { permissionKey: boolean }.
 */
export function buildPermissionMatrix(state) {
  const matrix = {};
  for (const role of getAllRoles(state)) {
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
  'Marketing':              { icon: 'mail',       color: 'cyan' },
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
