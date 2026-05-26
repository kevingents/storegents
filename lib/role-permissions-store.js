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
 * Bouw groep-mappings voor de UI matrix: PERMISSIONS gegroepeerd per "module".
 * De mockup laat secties zien als "Supplychain & Voorraad", "Orders & Klanten",
 * etc. Deze functie aggregeert PERMISSIONS naar zulke UI-groepen.
 */
export function buildUiSections() {
  /* Map our PERMISSIONS (key-prefix based) naar visuele groepen die in
     het mockup staan. Het mockup gebruikt "modules" met sub-rechten als
     Bekijken/Bewerken/Goedkeuren/Exporteren/Verwijderen — onze interne
     permissions zijn iets fijnmaziger maar we kunnen ze groeperen. */
  return [
    {
      id: 'supplychain',
      label: 'Supplychain & Voorraad',
      icon: 'package',
      color: 'orange',
      rights: [
        { id: 'voorraad-overview',    label: 'Voorraad overzicht',  permKey: 'page.openstaande-orders' },
        { id: 'voorraad-correcties',  label: 'Voorraadcorrecties',  permKey: 'page.niet-leverbaar' },
        { id: 'inventarisaties',      label: 'Inventarisaties',     permKey: 'page.te-laat' },
        { id: 'transfers',            label: 'Transfers',           permKey: 'page.uitwisselingen' },
        { id: 'niet-leverbaar',       label: 'Niet leverbaar',      permKey: 'page.niet-leverbaar' },
        { id: 'magazijnen',           label: 'Magazijnen',          permKey: 'page.routeplanning' }
      ]
    },
    {
      id: 'orders',
      label: 'Orders & Klanten',
      icon: 'cart',
      color: 'blue',
      rights: [
        { id: 'orders-bekijken',      label: 'Orders bekijken',     permKey: 'page.openstaande-orders' },
        { id: 'orders-bewerken',      label: 'Orders bewerken',     permKey: 'action.cancel-order' },
        { id: 'retouren',             label: 'Retouren verwerken',  permKey: 'page.retouren' },
        { id: 'klanten-bekijken',     label: 'Klanten bekijken',    permKey: 'page.klanten' }
      ]
    },
    {
      id: 'transport',
      label: 'Transport & Logistiek',
      icon: 'truck',
      color: 'green',
      rights: [
        { id: 'route-bekijken',       label: 'Routeplanning bekijken', permKey: 'page.routeplanning' },
        { id: 'dhl-labels',           label: 'DHL labels aanmaken',    permKey: 'action.create-label' },
        { id: 'zendingen',            label: 'Zendingen beheren',      permKey: 'action.create-label' }
      ]
    },
    {
      id: 'reports',
      label: 'Rapportages',
      icon: 'chart',
      color: 'amber',
      rights: [
        { id: 'rapporten-bekijken',   label: 'Rapporten bekijken',   permKey: 'page.rapportages' },
        { id: 'exports-uitvoeren',    label: 'Exports uitvoeren',    permKey: 'page.exports' }
      ]
    },
    {
      id: 'finance',
      label: 'Finance',
      icon: 'euro',
      color: 'purple',
      rights: [
        { id: 'finance-bekijken',     label: 'Financieel overzicht', permKey: 'page.finance' },
        { id: 'declaraties',          label: 'Declaraties',          permKey: 'page.declaraties' },
        { id: 'declaratie-goedk',     label: 'Declaratie goedkeuren',permKey: 'action.approve-declaration' }
      ]
    },
    {
      id: 'admin',
      label: 'Beheer & Systeem',
      icon: 'shield',
      color: 'red',
      rights: [
        { id: 'gebruikersbeheer',     label: 'Gebruikersbeheer',     permKey: 'page.gebruikersbeheer' },
        { id: 'gebruikers-edit',      label: 'Gebruikers + rechten bewerken', permKey: 'action.edit-user' },
        { id: 'instellingen',         label: 'Instellingen',         permKey: 'page.instellingen' },
        { id: 'integraties',          label: 'Integraties',          permKey: 'page.integraties' },
        { id: 'systeem-edit',         label: 'Systeem-instellingen wijzigen', permKey: 'action.edit-system' },
        { id: 'cron-run',             label: 'Cron handmatig draaien',permKey: 'action.run-cron' }
      ]
    }
  ];
}
