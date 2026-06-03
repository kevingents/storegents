/**
 * Department → Permissions mapping.
 *
 * Tijdens de migratie van het oude "afdelingen"-systeem naar een
 * permission-driven model krijgt elke afdeling een set extra permissies
 * die bovenop de rol-default worden toegekend.
 *
 * Bron-mapping is bewust conservatief opgesteld: een gebruiker uit
 * "Logistiek" krijgt operationele voorraad-acties maar geen finance-data,
 * en omgekeerd. Wanneer er twijfel is, kennen we het minder-toe en
 * laten we de admin per-user fine-tunen via de Rollen & rechten matrix.
 *
 * Gebruik:
 *   import { permissionsForDepartment } from './lib/department-permissions-mapping.js';
 *   const extras = permissionsForDepartment('Logistiek / magazijn');
 *   // extras = ['page.routeplanning', 'page.uitwisselingen', ...]
 */

import { DEPARTMENTS } from './user-roles.js';

/**
 * Per afdeling: lijst extra permissions (toegekend bovenop de rol-default).
 *
 * Keys MOETEN matchen met PERMISSIONS uit user-roles.js. Een onbekende key
 * wordt door isValidPermission() afgevangen.
 */
export const DEPARTMENT_PERMISSIONS = {
  /* HK = ziet alles operationeel + finance read + rapportages */
  'Hoofdkantoor': [
    'page.dashboard',
    'page.openstaande-orders',
    'page.te-laat',
    'page.niet-leverbaar',
    'page.routeplanning',
    'page.retouren',
    'page.klanten',
    'page.klant-zoeken',
    'page.finance',
    'page.declaraties',
    'page.omzet',
    'page.rapportages',
    'page.exports',
    'page.logs',
    'action.refund',
    'action.cancel-order',
    'action.create-label',
    'action.edit-customer',
    'data.all-stores'
  ],

  'Finance': [
    'page.dashboard',
    'page.finance',
    'page.declaraties',
    'page.omzet',
    'page.rapportages',
    'page.exports',
    'page.logs',
    'action.approve-declaration',
    'action.pay-declaration',
    'data.all-stores'
  ],

  'IT': [
    'page.dashboard',
    'page.systeemcontrole',
    'page.instellingen',
    'page.integraties',
    'page.gebruikersbeheer',
    'page.logs',
    'page.exports',
    'action.edit-system',
    'action.run-cron',
    'action.edit-user',
    'data.all-stores'
  ],

  'Marketing': [
    'page.dashboard',
    'page.klanten',
    'page.klant-zoeken',
    'page.omzet',
    'page.rapportages',
    'page.exports',
    'data.all-stores'
  ],

  'Inkoop': [
    'page.dashboard',
    'page.openstaande-orders',
    'page.niet-leverbaar',
    'page.supplychain-dashboard',
    'page.voorraad-gezondheid',
    'page.dragers',
    'page.derving',
    'page.exports',
    'page.rapportages',
    'data.all-stores'
  ],

  'Logistiek / magazijn': [
    'page.dashboard',
    'page.openstaande-orders',
    'page.te-laat',
    'page.routeplanning',
    'page.niet-leverbaar',
    'page.supplychain-dashboard',
    'page.voorraad-gezondheid',
    'page.dragers',
    'page.derving',
    'page.voorraad-correcties',
    'page.locaties',
    'action.create-label',
    'data.all-stores'
  ],

  'Customer service': [
    'page.dashboard',
    'page.openstaande-orders',
    'page.te-laat',
    'page.retouren',
    'page.klanten',
    'page.klant-zoeken',
    'action.refund',
    'action.cancel-order',
    'action.edit-customer',
    'action.gdpr-export',
    'action.merge-customer',
    'data.all-stores'
  ],

  /* Winkel medewerkers krijgen nog GEEN data.all-stores. Hun rol-default
     ('medewerker') geeft al data.own-store. Departement voegt niks extra. */
  'Winkel': [],

  /* Regiomanagement: rol-default 'regio_manager' dekt het. Geen extra's. */
  'Regiomanagement': [],

  /* Onbekend / leeg: niets extra's. */
  'Onbekend': []
};

/**
 * Geeft de extra permissions voor een afdeling. Onbekende of lege afdeling
 * → lege array.
 */
export function permissionsForDepartment(department) {
  if (!department) return [];
  const norm = String(department).trim();
  return DEPARTMENT_PERMISSIONS[norm] || [];
}

/**
 * Geeft een list van alle bekende departments + count van permissions.
 * Handig voor admin-UI ("Welke afdeling kent welke rechten toe").
 */
export function listDepartmentMappings() {
  return DEPARTMENTS.map((dept) => ({
    department: dept,
    extraPermissions: DEPARTMENT_PERMISSIONS[dept] || [],
    count: (DEPARTMENT_PERMISSIONS[dept] || []).length
  }));
}

/**
 * Reverse lookup — welke afdelingen kennen recht X toe? Handig voor
 * "Welke teams hebben pijp.uitwisselingen?".
 */
export function departmentsWithPermission(permKey) {
  return Object.entries(DEPARTMENT_PERMISSIONS)
    .filter(([, perms]) => perms.includes(permKey))
    .map(([dept]) => dept);
}
