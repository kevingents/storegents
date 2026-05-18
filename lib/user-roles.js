/**
 * Roles + departments + permissions catalog voor GENTS admin portal.
 *
 * Permissies zijn een string-set; een role komt met een default-set, een
 * specifieke gebruiker kan extra permissies toegevoegd/ontnomen krijgen via
 * lib/user-permissions-store.js.
 */

export const ROLES = [
  {
    key: 'admin',
    label: 'Beheerder',
    description: 'Volledige toegang tot alle pagina\'s, acties en data over alle winkels.',
    color: '#0f172a'
  },
  {
    key: 'regio_manager',
    label: 'Regiomanager',
    description: 'Ziet alle winkels in hun regio, kan rapportages bekijken en operationele acties uitvoeren.',
    color: '#0ea5e9'
  },
  {
    key: 'shop_manager',
    label: 'Shop manager',
    description: 'Beheert één winkel: orders, retouren, declaraties, klantprofielen.',
    color: '#10b981'
  },
  {
    key: 'medewerker',
    label: 'Winkelmedewerker',
    description: 'Operationele taken in eigen winkel (afhalen, verzendlabels, klant zoeken).',
    color: '#64748b'
  },
  {
    key: 'office',
    label: 'Kantoor / back-office',
    description: 'Hoofdkantoor: rapportages, mail-logs, support, declaraties (geen winkel-ops).',
    color: '#a855f7'
  },
  {
    key: 'finance',
    label: 'Finance',
    description: 'Finance + declaraties + open bedragen. Geen toegang tot winkel-operations.',
    color: '#f59e0b'
  },
  {
    key: 'readonly',
    label: 'Read-only',
    description: 'Mag alles inzien maar niks wijzigen — voor controllers / audits.',
    color: '#94a3b8'
  }
];

export const DEPARTMENTS = [
  'Winkel',
  'Regiomanagement',
  'Hoofdkantoor',
  'Marketing',
  'Finance',
  'IT',
  'Inkoop',
  'Logistiek / magazijn',
  'Customer service',
  'Onbekend'
];

/**
 * Permission keys. Gegroepeerd per categorie voor UI.
 * Indeling: `page.{name}` = nav-item zichtbaar / `action.{name}` = actie toegestaan.
 */
export const PERMISSIONS = [
  { category: 'Pages — Operationeel', key: 'page.dashboard',          label: 'Dashboard' },
  { category: 'Pages — Operationeel', key: 'page.afhaalorders',       label: 'Afhaalorders' },
  { category: 'Pages — Operationeel', key: 'page.openstaande-orders', label: 'Openstaande orders' },
  { category: 'Pages — Operationeel', key: 'page.te-laat',            label: 'Te laat orders' },
  { category: 'Pages — Operationeel', key: 'page.routeplanning',      label: 'Routeplanning' },
  { category: 'Pages — Operationeel', key: 'page.uitwisselingen',     label: 'Uitwisselingen' },
  { category: 'Pages — Operationeel', key: 'page.niet-leverbaar',     label: 'Niet leverbaar' },
  { category: 'Pages — Operationeel', key: 'page.retouren',           label: 'Retouren' },

  { category: 'Pages — Klant',        key: 'page.klanten',            label: 'Klanten' },
  { category: 'Pages — Klant',        key: 'page.klant-zoeken',       label: 'Klant zoeken' },

  { category: 'Pages — Finance',      key: 'page.finance',            label: 'Finance / open bedragen' },
  { category: 'Pages — Finance',      key: 'page.declaraties',        label: 'Declaraties' },
  { category: 'Pages — Finance',      key: 'page.omzet',              label: 'Omzet & trend' },

  { category: 'Pages — Analytics',    key: 'page.rapportages',        label: 'Rapportages catalog' },
  { category: 'Pages — Analytics',    key: 'page.logs',               label: 'Logs' },
  { category: 'Pages — Analytics',    key: 'page.exports',            label: 'Exports' },

  { category: 'Pages — Admin',        key: 'page.systeemcontrole',    label: 'Systeemcontrole' },
  { category: 'Pages — Admin',        key: 'page.instellingen',       label: 'Instellingen' },
  { category: 'Pages — Admin',        key: 'page.integraties',        label: 'Integraties' },
  { category: 'Pages — Admin',        key: 'page.gebruikersbeheer',   label: 'Gebruikersbeheer' },

  { category: 'Acties — Orders',      key: 'action.refund',           label: 'Refund uitvoeren' },
  { category: 'Acties — Orders',      key: 'action.cancel-order',     label: 'Order annuleren in SRS' },
  { category: 'Acties — Orders',      key: 'action.create-label',     label: 'Verzendlabel aanmaken' },

  { category: 'Acties — Klant',       key: 'action.edit-customer',    label: 'Klantgegevens bewerken' },
  { category: 'Acties — Klant',       key: 'action.gdpr-export',      label: 'GDPR export' },
  { category: 'Acties — Klant',       key: 'action.merge-customer',   label: 'Klanten samenvoegen' },

  { category: 'Acties — Finance',     key: 'action.approve-declaration', label: 'Declaratie goedkeuren' },
  { category: 'Acties — Finance',     key: 'action.pay-declaration',     label: 'Declaratie uitbetalen' },

  { category: 'Acties — Admin',       key: 'action.edit-user',        label: 'Gebruikers + rechten beheren' },
  { category: 'Acties — Admin',       key: 'action.edit-system',      label: 'Systeem-instellingen wijzigen' },
  { category: 'Acties — Admin',       key: 'action.run-cron',         label: 'Cron handmatig draaien' },

  { category: 'Data',                 key: 'data.all-stores',         label: 'Data van alle winkels zien' },
  { category: 'Data',                 key: 'data.own-region',         label: 'Data van eigen regio zien' },
  { category: 'Data',                 key: 'data.own-store',          label: 'Alleen eigen winkel zien' }
];

const PERM_KEYS = PERMISSIONS.map((p) => p.key);

/**
 * Default permissies per rol. Dit is een whitelist — alleen deze keys zijn
 * standaard toegekend. Custom overrides per gebruiker komen daar bovenop.
 */
export const ROLE_DEFAULT_PERMISSIONS = {
  admin: PERM_KEYS, /* alles */

  regio_manager: [
    'page.dashboard','page.afhaalorders','page.openstaande-orders','page.te-laat',
    'page.routeplanning','page.uitwisselingen','page.niet-leverbaar','page.retouren',
    'page.klanten','page.klant-zoeken',
    'page.finance','page.declaraties','page.omzet',
    'page.rapportages','page.logs','page.exports',
    'action.refund','action.cancel-order','action.create-label',
    'action.edit-customer','action.gdpr-export',
    'action.approve-declaration',
    'data.own-region'
  ],

  shop_manager: [
    'page.dashboard','page.afhaalorders','page.openstaande-orders','page.te-laat',
    'page.uitwisselingen','page.niet-leverbaar','page.retouren',
    'page.klanten','page.klant-zoeken',
    'page.declaraties',
    'page.rapportages',
    'action.refund','action.cancel-order','action.create-label',
    'action.edit-customer',
    'data.own-store'
  ],

  medewerker: [
    'page.dashboard','page.afhaalorders','page.openstaande-orders',
    'page.uitwisselingen','page.niet-leverbaar',
    'page.klant-zoeken',
    'action.create-label',
    'data.own-store'
  ],

  office: [
    'page.dashboard',
    'page.openstaande-orders','page.te-laat',
    'page.klanten','page.klant-zoeken',
    'page.rapportages','page.logs','page.exports',
    'page.declaraties','page.omzet',
    'data.all-stores'
  ],

  finance: [
    'page.dashboard',
    'page.finance','page.declaraties','page.omzet',
    'page.rapportages','page.exports',
    'action.approve-declaration','action.pay-declaration',
    'data.all-stores'
  ],

  readonly: [
    'page.dashboard','page.afhaalorders','page.openstaande-orders','page.te-laat',
    'page.routeplanning','page.uitwisselingen','page.niet-leverbaar','page.retouren',
    'page.klanten','page.klant-zoeken',
    'page.finance','page.declaraties','page.omzet',
    'page.rapportages','page.logs','page.exports',
    'data.all-stores'
  ]
};

export function rolePermissions(roleKey) {
  return ROLE_DEFAULT_PERMISSIONS[roleKey] || [];
}

export function isValidPermission(key) {
  return PERM_KEYS.includes(key);
}

export function resolvePermissions(roleKey, grants = [], revokes = []) {
  const base = new Set(rolePermissions(roleKey));
  (grants || []).forEach((g) => { if (isValidPermission(g)) base.add(g); });
  (revokes || []).forEach((r) => base.delete(r));
  return Array.from(base);
}
