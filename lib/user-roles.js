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
 * Permission catalog — volledige lijst van wat een gebruiker kan zien en doen.
 *
 * Categorieën zijn de groepen die in de matrix-UI worden getoond (één blok
 * per categorie, samenklapbaar). Labels zijn klant-vriendelijk Nederlands,
 * geen technische termen.
 *
 * Naamgeving van keys:
 *   page.X     — een pagina of modal die geopend mag worden
 *   action.X   — een actie die data wijzigt
 *   data.X     — wat een gebruiker mag inzien aan databereik
 */
export const PERMISSIONS = [
  /* ───────── Dagelijks werk ───────── */
  { category: 'Dagelijks werk', key: 'page.dashboard',           label: 'Dashboard bekijken' },
  { category: 'Dagelijks werk', key: 'page.activity',            label: 'Recente activiteit volgen' },
  { category: 'Dagelijks werk', key: 'page.openstaande-orders',  label: 'Openstaande orders' },
  { category: 'Dagelijks werk', key: 'page.te-laat',             label: 'Te-late orders' },
  { category: 'Dagelijks werk', key: 'page.niet-leverbaar',      label: 'Niet leverbaar' },
  { category: 'Dagelijks werk', key: 'page.retouren',            label: 'Retouren & terugbetalingen' },
  { category: 'Dagelijks werk', key: 'page.uitwisselingen',      label: 'Uitwisselingen tussen winkels' },
  { category: 'Dagelijks werk', key: 'page.afhaalorders',        label: 'Afhaalorders in de winkel' },
  { category: 'Dagelijks werk', key: 'page.pickup',              label: 'Afhaalmodal openen' },
  { category: 'Dagelijks werk', key: 'page.store-open-weborders',label: 'Open weborders deze winkel' },

  /* ───────── Klanten ───────── */
  { category: 'Klanten', key: 'page.klanten',                    label: 'Klantenoverzicht' },
  { category: 'Klanten', key: 'page.klant-zoeken',               label: 'Klant zoeken (snelzoek)' },
  { category: 'Klanten', key: 'page.customer-lookup',            label: 'Klant opzoeken (modal)' },
  { category: 'Klanten', key: 'page.customer-create',            label: 'Nieuwe klant aanmaken' },
  { category: 'Klanten', key: 'page.store-customer-month',       label: 'Klantenrapport per maand (winkel)' },
  { category: 'Klanten', key: 'action.edit-customer',            label: 'Klantgegevens bewerken' },
  { category: 'Klanten', key: 'action.merge-customer',           label: 'Klanten samenvoegen' },
  { category: 'Klanten', key: 'action.gdpr-export',              label: 'AVG/GDPR export voor klant' },

  /* ───────── Voorraad & artikelen ───────── */
  { category: 'Voorraad & artikelen', key: 'page.voorraad-correcties',     label: 'Voorraadcorrecties (admin)' },
  { category: 'Voorraad & artikelen', key: 'page.stock-correction-request',label: 'Voorraadcorrectie aanvragen (winkel)' },
  { category: 'Voorraad & artikelen', key: 'page.article-search',          label: 'Voorraad opzoeken' },
  { category: 'Voorraad & artikelen', key: 'page.supplychain-dashboard',   label: 'Supplychain dashboard' },
  { category: 'Voorraad & artikelen', key: 'page.supplychain-config',      label: 'Supplychain metrics-instellingen' },
  { category: 'Voorraad & artikelen', key: 'page.voorraad-gezondheid',     label: 'Voorraad-gezondheid' },
  { category: 'Voorraad & artikelen', key: 'page.merchandiser',            label: 'Merchandiser (herverdeling/doorverkoop)' },
  { category: 'Voorraad & artikelen', key: 'page.dragers',                 label: 'Openstaande dragers' },
  { category: 'Voorraad & artikelen', key: 'page.derving',                 label: 'Derving' },
  { category: 'Voorraad & artikelen', key: 'page.locaties',                label: 'Winkels & magazijnen overzicht' },
  { category: 'Voorraad & artikelen', key: 'action.approve-correction',    label: 'Voorraadcorrectie goedkeuren' },

  /* ───────── Transport ───────── */
  { category: 'Transport', key: 'page.routeplanning',          label: 'Routeplanning' },
  { category: 'Transport', key: 'page.transport-route',        label: 'Transport route (admin)' },
  { category: 'Transport', key: 'page.transport-facturen',     label: 'DHL facturen' },
  { category: 'Transport', key: 'page.transport-prestaties',   label: 'DHL prestaties' },
  { category: 'Transport', key: 'page.dhl-noshow',             label: 'DHL no-shows' },
  { category: 'Transport', key: 'page.created-labels',         label: 'Gemaakte verzendlabels' },
  { category: 'Transport', key: 'page.sendcloud-label-report', label: 'SendCloud label-rapport' },
  { category: 'Transport', key: 'page.label',                  label: 'Verzendlabel modal' },
  { category: 'Transport', key: 'action.create-label',         label: 'Verzendlabel aanmaken' },

  /* ───────── Orders & verkoop ───────── */
  { category: 'Orders & verkoop', key: 'page.refund',                  label: 'Refund modal' },
  { category: 'Orders & verkoop', key: 'page.refund-order',            label: 'Order-refund flow' },
  { category: 'Orders & verkoop', key: 'page.exchanges',               label: 'Uitwisselingen-modal' },
  { category: 'Orders & verkoop', key: 'page.uitwisseling-create',     label: 'Uitwisseling aanmaken' },
  { category: 'Orders & verkoop', key: 'page.reservering-maken',       label: 'Reservering aanmaken' },
  { category: 'Orders & verkoop', key: 'page.reserveringen',           label: 'Reserveringen-pagina' },
  { category: 'Orders & verkoop', key: 'page.reserveringen-list',      label: 'Reserveringen-lijst (winkel)' },
  { category: 'Orders & verkoop', key: 'page.admin-reserveringen',     label: 'Reserveringen (admin)' },
  { category: 'Orders & verkoop', key: 'page.vouchers',                label: 'Vouchers / kortingscodes' },
  { category: 'Orders & verkoop', key: 'page.omzet',                   label: 'Omzet & trend' },
  { category: 'Orders & verkoop', key: 'page.store-revenue-detail',    label: 'Omzet-detail per winkel' },
  { category: 'Orders & verkoop', key: 'action.refund',                label: 'Refund uitvoeren' },
  { category: 'Orders & verkoop', key: 'action.cancel-order',          label: 'Order annuleren in SRS' },

  /* ───────── Finance ───────── */
  { category: 'Finance', key: 'page.finance',                    label: 'Financieel overzicht' },
  { category: 'Finance', key: 'page.declaraties',                label: 'Declaraties (admin)' },
  { category: 'Finance', key: 'page.declarations-overview',      label: 'Mijn declaraties' },
  { category: 'Finance', key: 'page.declaration-submit',         label: 'Declaratie indienen' },
  { category: 'Finance', key: 'page.declarations-admin',         label: 'Declaraties-beheer' },
  { category: 'Finance', key: 'page.admin-refunds-daily',        label: 'Refunds dagoverzicht (admin)' },
  { category: 'Finance', key: 'action.approve-declaration',      label: 'Declaratie goedkeuren' },
  { category: 'Finance', key: 'action.pay-declaration',          label: 'Declaratie uitbetalen' },

  /* ───────── Rapportages & data ───────── */
  { category: 'Rapportages & data', key: 'page.rapportages',                   label: 'Alle rapportages' },
  { category: 'Rapportages & data', key: 'page.jaaranalyse',                   label: 'Jaaranalyse (omzet jaar-op-jaar)' },
  { category: 'Rapportages & data', key: 'page.rapportbouwer',                 label: 'Rapportbouwer (eigen rapporten)' },
  { category: 'Rapportages & data', key: 'page.reports',                       label: 'Rapporten & tools' },
  { category: 'Rapportages & data', key: 'page.exports',                       label: 'Exports' },
  { category: 'Rapportages & data', key: 'page.logs',                          label: 'Logs' },
  { category: 'Rapportages & data', key: 'page.customer-targets',              label: 'Klanten-targets per maand' },
  { category: 'Rapportages & data', key: 'page.exchanges-report',              label: 'Uitwisselingen-rapport' },
  { category: 'Rapportages & data', key: 'page.admin-store-week-report',       label: 'Winkel weekrapport (admin)' },
  { category: 'Rapportages & data', key: 'page.admin-customer-weekly-report',  label: 'Klanten weekrapport (admin)' },
  { category: 'Rapportages & data', key: 'page.admin-omnichannel-score',       label: 'Omnichannel-score' },
  { category: 'Rapportages & data', key: 'page.admin-google-reviews',          label: 'Google reviews (admin)' },
  { category: 'Rapportages & data', key: 'page.store-google-reviews',          label: 'Google reviews (winkel)' },
  { category: 'Rapportages & data', key: 'page.store-insights',                label: 'Winkel-inzichten' },
  { category: 'Rapportages & data', key: 'page.admin-region-reporting',        label: 'Regio rapportage' },
  { category: 'Rapportages & data', key: 'page.admin-unavailable-report',      label: 'Niet-leverbaar rapport' },
  { category: 'Rapportages & data', key: 'page.admin-weborders-overdue',       label: 'Te-late weborders (admin)' },
  { category: 'Rapportages & data', key: 'page.admin-exchanges',               label: 'Uitwisselingen-beheer' },
  { category: 'Rapportages & data', key: 'page.article-search',                label: 'Artikelen zoeken (geavanceerd)' },

  /* ───────── Communicatie ───────── */
  { category: 'Communicatie', key: 'page.admin-mail-log',                 label: 'Mail log' },
  { category: 'Communicatie', key: 'page.admin-report-schedules',         label: 'Geplande rapportages' },
  { category: 'Communicatie', key: 'page.admin-send-notification',        label: 'Notificatie versturen' },
  { category: 'Communicatie', key: 'page.admin-support-tickets',          label: 'Support tickets (admin)' },
  { category: 'Communicatie', key: 'page.my-tickets',                     label: 'Mijn support tickets' },
  { category: 'Communicatie', key: 'page.support',                        label: 'Support modal' },
  { category: 'Communicatie', key: 'page.admin-overdue-reminder-status',  label: 'Te-late herinneringen status' },
  { category: 'Communicatie', key: 'page.admin-automation-status',        label: 'Automatiseringen status' },
  { category: 'Communicatie', key: 'page.faq',                            label: 'FAQ bekijken' },
  { category: 'Communicatie', key: 'page.function-help',                  label: 'Functie-help bekijken' },
  { category: 'Communicatie', key: 'page.admin-faq-editor',               label: 'FAQ bewerken' },
  { category: 'Communicatie', key: 'page.admin-function-help-editor',     label: 'Functie-help bewerken' },

  /* ───────── Studentenverenigingen ───────── */
  { category: 'Studentenverenigingen', key: 'page.students',               label: 'Studentenomzet' },
  { category: 'Studentenverenigingen', key: 'page.vereniging-deals',       label: 'Vereniging deals' },
  { category: 'Studentenverenigingen', key: 'page.store-vereniging-deals', label: 'Deals tonen in winkel' },

  /* ───────── Suitconcer ───────── */
  { category: 'Suitconcer', key: 'page.sc-voorraad',         label: 'Suitconcer voorraad' },
  { category: 'Suitconcer', key: 'page.sc-artikelen',        label: 'Suitconcer artikelen' },
  { category: 'Suitconcer', key: 'page.sc-orders',           label: 'Suitconcer orders' },
  { category: 'Suitconcer', key: 'page.sc-uniek-aanbod',     label: 'Suitconcer uniek aanbod' },

  /* ───────── Facilitair ───────── */
  { category: 'Facilitair', key: 'page.facilitair-order',     label: 'Facilitaire bestelling plaatsen' },
  { category: 'Facilitair', key: 'page.facilitair-my-orders', label: 'Mijn facilitaire bestellingen' },
  { category: 'Facilitair', key: 'page.facilitair-report',    label: 'Facilitair rapport' },
  { category: 'Facilitair', key: 'page.admin-facilitair',     label: 'Facilitair beheer (admin)' },

  /* ───────── Trofeekast ───────── */
  { category: 'Trofeekast', key: 'page.trophy-cabinet', label: 'Trofeekast bekijken' },

  /* ───────── Marketing ───────── */
  { category: 'Marketing', key: 'page.marketing-dashboard', label: 'Marketing dashboard' },
  { category: 'Marketing', key: 'page.bundels',             label: 'Mix & Match (pakken)' },
  { category: 'Marketing', key: 'page.marketing-fotostatus', label: 'Te fotograferen (inkoop)' },

  /* ───────── Marketplace ───────── */
  { category: 'Marketplace', key: 'page.bol', label: 'bol.com beheer' },

  /* ───────── Inkoop ───────── */
  { category: 'Inkoop', key: 'page.inkoop-open',     label: 'Openstaande inkooporders' },
  { category: 'Inkoop', key: 'page.inkoop-nieuw',    label: 'Inkooporder aanmaken' },
  { category: 'Inkoop', key: 'page.leveranciers',    label: 'Leveranciers beheren' },
  { category: 'Inkoop', key: 'action.inkoop-mail',   label: 'Inkooporder mailen naar leverancier' },
  { category: 'Inkoop', key: 'action.inkoop-push',   label: 'Inkooporder doorzetten naar SRS' },

  /* ───────── HR ───────── */
  { category: 'HR', key: 'page.hr',                  label: 'HR productiviteit (omzet/uren per filiaal)' },
  { category: 'HR', key: 'page.hr-verlof',           label: 'Verlof-overzicht (wie is afwezig)' },
  { category: 'HR', key: 'page.hr-vacatures',        label: 'Vacatures & sollicitanten' },
  { category: 'HR', key: 'action.manage-vacancies',  label: 'Vacatures beheren + sollicitanten beoordelen' },
  { category: 'HR', key: 'page.werktijden-config',   label: 'Werktijden-koppeling instellen' },

  /* ───────── Beheer ───────── */
  { category: 'Beheer', key: 'page.gebruikersbeheer',       label: 'Gebruikers' },
  { category: 'Beheer', key: 'page.roles-permissions',      label: 'Rollen & rechten' },
  { category: 'Beheer', key: 'page.toegangsmatrix',         label: 'Toegangsmatrix (legacy)' },
  { category: 'Beheer', key: 'page.virtual-stores',         label: 'Afdelingen (deprecated)' },
  { category: 'Beheer', key: 'page.groepen',                label: 'Groepen & teams' },
  { category: 'Beheer', key: 'page.functiesjablonen',       label: 'Functiesjablonen' },
  { category: 'Beheer', key: 'page.takenplanner',           label: 'Takenplanner' },
  { category: 'Beheer', key: 'page.user-profile',           label: 'Eigen profiel bewerken' },
  { category: 'Beheer', key: 'page.admin-store-emails',     label: 'Winkel-emails configureren' },
  { category: 'Beheer', key: 'page.admin-dhl-hubs',         label: 'DHL hubs beheren' },
  { category: 'Beheer', key: 'page.admin-feature-flags',    label: 'Feature flags' },
  { category: 'Beheer', key: 'action.edit-user',            label: 'Gebruikers + rechten beheren' },

  /* ───────── Systeem ───────── */
  { category: 'Systeem', key: 'page.systeemcontrole',     label: 'Systeemcontrole' },
  { category: 'Systeem', key: 'page.cron-overzicht',      label: 'Cron-overzicht' },
  { category: 'Systeem', key: 'page.admin-cron-config',   label: 'Cron-config bewerken' },
  { category: 'Systeem', key: 'page.admin-system-health', label: 'Systeem-health monitor' },
  { category: 'Systeem', key: 'page.admin-system-info',   label: 'Systeem-info (env-vars + config)' },
  { category: 'Systeem', key: 'page.admin-kpis',          label: 'KPI-beheer (targets + thresholds)' },
  { category: 'Systeem', key: 'page.offline-sync',        label: 'Offline → Shopify sync' },
  { category: 'Systeem', key: 'page.integraties',         label: 'Integraties' },
  { category: 'Systeem', key: 'page.instellingen',        label: 'Instellingen' },
  { category: 'Systeem', key: 'action.edit-system',       label: 'Systeem-instellingen wijzigen' },
  { category: 'Systeem', key: 'action.run-cron',          label: 'Cron handmatig draaien' },

  /* ───────── Databereik ───────── */
  { category: 'Databereik', key: 'data.all-stores',  label: 'Alle winkels zien' },
  { category: 'Databereik', key: 'data.own-region',  label: 'Eigen regio zien' },
  { category: 'Databereik', key: 'data.own-store',   label: 'Alleen eigen winkel zien' }
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
    'page.rapportages','page.jaaranalyse','page.rapportbouwer','page.logs','page.exports',
    'action.refund','action.cancel-order','action.create-label',
    'action.edit-customer','action.gdpr-export',
    'action.approve-declaration',
    'page.hr','page.hr-verlof','page.hr-vacatures','action.manage-vacancies',
    'page.inkoop-open','page.inkoop-nieuw','page.leveranciers','action.inkoop-mail','action.inkoop-push',
    'page.voorraad-gezondheid','page.merchandiser',
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
    'page.hr','page.hr-verlof','page.hr-vacatures',
    'data.own-store'
  ],

  medewerker: [
    'page.dashboard','page.afhaalorders','page.openstaande-orders',
    'page.uitwisselingen','page.niet-leverbaar',
    'page.klant-zoeken',
    'page.hr-verlof',
    'action.create-label',
    'data.own-store'
  ],

  office: [
    'page.dashboard',
    'page.openstaande-orders','page.te-laat',
    'page.klanten','page.klant-zoeken',
    'page.rapportages','page.jaaranalyse','page.logs','page.exports',
    'page.voorraad-gezondheid','page.merchandiser',
    'page.declaraties','page.omzet',
    'data.all-stores'
  ],

  finance: [
    'page.dashboard',
    'page.finance','page.declaraties','page.omzet',
    'page.rapportages','page.jaaranalyse','page.exports',
    'action.approve-declaration','action.pay-declaration',
    'data.all-stores'
  ],

  readonly: [
    'page.dashboard','page.afhaalorders','page.openstaande-orders','page.te-laat',
    'page.routeplanning','page.uitwisselingen','page.niet-leverbaar','page.retouren',
    'page.klanten','page.klant-zoeken',
    'page.finance','page.declaraties','page.omzet',
    'page.rapportages','page.jaaranalyse','page.logs','page.exports',
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
