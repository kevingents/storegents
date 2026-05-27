/**
 * GENTS Portal — Centrale Business Config
 * =======================================
 *
 * Single source of truth voor alle bedrijfsregels die je zonder code-deploy
 * zou willen kunnen aanpassen. Vóór dit bestand stond elke waarde verspreid
 * over 5-30 files; één wijziging vergat altijd ergens een plek.
 *
 * # WANNEER GEBRUIK JE WAT?
 *
 * - **Deze file (BUSINESS_CONFIG)**: defaults voor alle bedrijfslogica.
 *   Code leest CONFIG.deadlines.weborderOperationalDays — NIET een
 *   gedupliceerd magic-number.
 *
 * - **Env-vars (Vercel)**: secrets (tokens, API keys) en omgevings-specifieke
 *   waardes. Veel constanten hieronder hebben een `process.env.XXX || default`
 *   pattern zodat noodgevallen via Vercel-dashboard fixbaar zijn.
 *
 * - **Vercel Blob (config/*.json)**: waardes die de business via een
 *   admin-modal aanpast (bv. region-report-config, role-permissions,
 *   stock-correction-reasons). Code leest die via *-store.js libs.
 *
 * # NIEUWE WAARDE TOEVOEGEN
 *
 * 1. Voeg toe aan het juiste sub-object hieronder (groepering: deadlines /
 *    targets / scoring / cache / etc.).
 *
 * 2. Schrijf JSDoc-comment: WAT betekent het, WAAR wordt het gebruikt,
 *    WANNEER zou het wijzigen.
 *
 * 3. Update `docs/CONFIGURATION.md` met dezelfde uitleg voor non-dev
 *    onboarding.
 *
 * 4. Refactor bestaande callsites om CONFIG.xxx.yyy te lezen ipv hardcoded.
 *    Bij twijfel: zoek de huidige waarde via grep en check alle locaties.
 *
 * # NIET ALLES HOORT HIER
 *
 * - Implementatie-details (algoritmes, schema-versies) — die zijn code.
 * - Per-user-overrides — die in user-permissions of user-profile.
 * - Secrets — die in env-vars (Vercel-dashboard).
 *
 * Vuistregel: "Zou de business owner deze waarde willen kunnen wijzigen
 * zonder developer?" Ja → hier. Nee → in code.
 */

export const BUSINESS_CONFIG = Object.freeze({

  /**
   * ===========================================================
   * DEADLINES & OVERDUE-REGELS
   * ===========================================================
   * Drijven alle "te laat"-meldingen, overdue-rapporten, mail-trigger-momenten.
   * Verandering = directe verschuiving in alle overdue-counts in dashboards.
   */
  deadlines: Object.freeze({
    /** Hoeveel dagen mag een weborder open staan voor hij "te laat" wordt.
     *  Trigger voor: admin-weborders-overdue, mail-naar-winkel cron, KPI's.
     *  Bron: gents-business-deadline.js, region-report-config-store.js. */
    weborderOperationalDays: Number(process.env.WEBORDER_DEADLINE_OPERATIONAL_DAYS) || 2,

    /** Hoeveel dagen mag een uitwisseling open staan voor hij "te laat" is.
     *  Trigger voor: admin-exchanges rood-markering, region-manager-weekly-report. */
    exchangeOperationalDays: Number(process.env.EXCHANGE_DEADLINE_OPERATIONAL_DAYS) || 7,

    /** Hoeveel UUR mag een drager (= verzendlabel-pakket) onderweg zijn
     *  voor we 'm "vermist" noemen. Onbedoeld 11× gedupliceerd vóór deze
     *  refactor — verandering in beleid betekent overdue-mail-spam als
     *  je 1 plek mist. */
    dragerHours: Number(process.env.DRAGER_DEADLINE_HOURS) || 48,

    /** Weborder-fulfilment SLA in uren. Aparte threshold van weborder-
     *  Operational omdat sommige winkels hun eigen tempo hebben. */
    weborderHours: Number(process.env.WEBORDER_DEADLINE_HOURS) || 48,

    /** Reservering: hoe lang geldig na aanmaken. Klant moet binnen X dagen
     *  ophalen anders status → 'verlopen' en voorraad terug. */
    reservationValidDays: Number(process.env.RESERVATION_VALID_DAYS) || 7,

    /** Reservering: hoe lang zichtbaar in "mijn reserveringen" lijst na verloop. */
    reservationCleanupDays: Number(process.env.RESERVATION_CLEANUP_DAYS) || 30
  }),

  /**
   * ===========================================================
   * TARGETS PER WINKEL — DEFAULTS
   * ===========================================================
   * Default-waardes voor omnichannel-score-berekening. Per-winkel
   * overrides via Vercel Blob (region-report-config / customer-targets).
   * Hier alleen de fallback als geen override gezet is.
   */
  targets: Object.freeze({
    /** Aantal nieuwe klant-registraties per winkel per maand (target). */
    customerRegistrations: 10,
    /** Aantal loyalty-opt-ins per winkel per maand. */
    loyaltyOptIn: 8,
    /** % vouchers dat gebruikt wordt (van uitgegeven). */
    voucherUsageRatePct: 60,
    /** Aantal verzendlabels per winkel per week. */
    labelsPerWeek: 5
  }),

  /**
   * ===========================================================
   * OMNICHANNEL SCORE — FORMULE
   * ===========================================================
   * Weegfactoren + penalties voor de trofeekast / winkel-ranking.
   * Som van weights MOET 1.0 zijn — anders worden scores scheef.
   * Penalties zijn aftrek-punten op een schaal van ~0-100.
   */
  omnichannelScoring: Object.freeze({
    /** Pillar-gewichten (som = 1.0) */
    weights: { base: 0.35, stock: 0.30, voucher: 0.10, srs: 0.10, service: 0.15 },
    /** Sub-weights binnen 'base' (klant + loyalty) */
    baseWeights: { customer: 0.6, loyalty: 0.4 },
    /** Sub-weights binnen 'service' (labels + tracking) */
    serviceWeights: { label: 0.7, tracking: 0.3 },
    /** Penalties (aftrekpunten per incident) */
    penalties: {
      unavailable: 15,      // niet-leverbaar regel
      cancelled: 10,        // geannuleerde order
      failed: 12,           // mislukte mail
      negStockLine: 4,      // negatieve voorraad-regel
      negStockPiece: 2,     // negatieve voorraad per stuk
      overdueExchange: 10,  // uitwisseling > 7 dagen
      voucherFailed: 10     // mislukte voucher-uitgifte
    }
  }),

  /**
   * ===========================================================
   * WK POULE SCORING
   * ===========================================================
   * Punten per match-uitkomst. Tijdens toernooi schaal-aanpassen
   * (bv. "knock-outs tellen dubbel") kan hier zonder code-edit.
   */
  wkPouleScoring: Object.freeze({
    pointsExact: 10,        // 100% juiste uitslag
    pointsToto: 5,          // winnaar/gelijkspel correct
    pointsSaldo: 3,         // doelsaldo correct
    bonusNumberTolerancePct: 0.05, // ±5% voor numerieke bonus-vragen
    topWeekDays: 7,         // venster voor "top voorspeller van de week"
    topWeekSlots: 3         // hoeveel spelers op het podium
  }),

  /**
   * ===========================================================
   * WK POULE TOERNOOI METADATA
   * ===========================================================
   */
  wkPouleTournament: Object.freeze({
    /** Wanneer begint het WK — deadline voor bonusvragen + countdown.
     *  Aanpassen voor nieuwe edities (WK 2030 etc.). */
    deadlineIso: process.env.WK_POULE_DEADLINE || '2026-06-11T16:00:00Z'
  }),

  /**
   * ===========================================================
   * MAIL & RAPPORTAGE
   * ===========================================================
   */
  mail: Object.freeze({
    /** REGEX voor toegestane recipient-domains. Beveiliging tegen
     *  per-ongeluk klantdata mailen. Bij overname/rename moet hier
     *  een nieuw domein bij (bv. /^[a-z0-9._%+-]+@(gents|nieuwemoeder)\.nl$/i). */
    allowedDomainRegex: /^[a-z0-9._%+-]+@gents\.nl$/i,
    /** Mens-leesbare label voor UI-foutmeldingen. */
    allowedDomainLabel: '@gents.nl',
    /** Max ontvangers per geplande rapportage. Bij "alle 19 winkels +
     *  regio-managers" kan 10 te krap zijn. */
    maxRecipientsPerSchedule: Number(process.env.MAIL_MAX_RECIPIENTS) || 10,
    /** Default uur (UTC) waarop nieuwe rapportage-schedules draaien.
     *  7 UTC = ~08:00 NL in winter, ~09:00 NL in zomer. */
    defaultScheduleHourUtc: 7,
    /** Max upload-grootte voor bijlagen (declaraties, supporttickets). */
    maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES) || (10 * 1024 * 1024),
    /** Hoe lang mail-events bewaard worden in audit-log. GDPR-overweging. */
    eventsRetentionDays: 90
  }),

  /**
   * ===========================================================
   * SESSIES & INVITES
   * ===========================================================
   */
  session: Object.freeze({
    /** Hoe lang een ingelogde portal-sessie geldig blijft (sec). */
    personnelTtlSeconds: Number(process.env.PERSONNEL_SESSION_TTL_SECONDS) || (12 * 60 * 60),
    /** Hoe lang een invite-link werkt voor office-users (ms). */
    inviteTtlMs: Number(process.env.INVITE_TTL_MS) || (2 * 24 * 60 * 60 * 1000),
    /** Hoe lang een 2FA-code geldig is (ms). */
    twoFaTtlMs: 5 * 60 * 1000
  }),

  /**
   * ===========================================================
   * CACHE TTLs — IN-MEMORY
   * ===========================================================
   * Per-endpoint cache duur. Centrale tabel zodat tuning bij rate-limit-
   * problemen op 1 plek gebeurt. Eenheid: milliseconden.
   *
   * RICHTLIJNEN:
   * - Hoog (>=10min): trage SRS-calls, weinig veranderend (locations)
   * - Middel (1-5min): redelijk stabiel maar dagelijks updaten
   * - Laag (<60s): real-time data (leaderboards, watermarks)
   */
  cache: Object.freeze({
    featureFlagsMs: 30_000,
    storeNotificationsMs: 10_000,
    userPermissionsMs: 30_000,
    permissionsAuditMs: 15_000,
    pickupOrdersMs: 15 * 60_000,
    srsWebordersMs: 10 * 60_000,
    srsStockSnapshotMs: 30 * 60_000,
    shopifyLocationsMs: 60 * 60_000,
    shopifyProductsMs: 24 * 60 * 60_000, // 1× per dag via cron
    googleReviewsRegionMs: 30 * 60_000,
    wkLeaderboardMs: 60_000,
    reportCacheDefaultMs: 15 * 60_000
  }),

  /**
   * ===========================================================
   * API & SOAP TIMEOUTS
   * ===========================================================
   * Hoeveel ms wachten we voor we een externe call opgeven.
   * SOAP=SRS (langzaam), GraphQL=Shopify (sneller), internal=tussen
   * onze eigen endpoints. Te laag → false-positive faalmeldingen,
   * te hoog → user wacht onnodig lang.
   */
  timeouts: Object.freeze({
    srsSoapMs: Number(process.env.SRS_SOAP_TIMEOUT_MS) || 20_000,
    shopifyGraphqlMs: 15_000,
    shopifySearchMs: 12_000,
    returnistaMs: 30_000,
    googleBusinessMs: 15_000,
    internalFetchMs: 25_000
  }),

  /**
   * ===========================================================
   * SHOPIFY GRAPHQL — PAGING
   * ===========================================================
   * Aantal items per query. Verhogen = minder API-calls maar hoger
   * GraphQL-cost (Shopify limiet = 1000 punten per request, ~50ms
   * recovery per punt).
   */
  shopifyPaging: Object.freeze({
    ordersPerPage: 50,
    productsPerPage: 100,
    variantsPerPage: 100,
    lineItemsPerPage: 50,
    fulfillmentsPerPage: 50,
    fulfillmentOrdersPerPage: 20
  }),

  /**
   * ===========================================================
   * BRANCHES (winkels) — single source
   * ===========================================================
   * Vóór deze refactor stond deze lijst gedupliceerd in 3 files:
   * - lib/branch-metrics.js (24 entries, met Antwerpen + IDs)
   * - lib/gents-mail-config.js (19 entries, geen Antwerpen)
   * - shopifystore/sections/gents-portal-v6.liquid (24 entries met
   *   fantoom-winkels Apeldoorn/Den Haag/Eindhoven/Hoofddorp die NIET
   *   in backend bestonden — UI toonde winkels zonder data)
   *
   * Nu: deze BUSINESS_CONFIG.branches.list is de canonical lijst.
   * gents-mail-config.js + branch-metrics.js MOETEN hier uit lezen.
   * Liquid leest 'm via een dedicated /api/branches endpoint.
   *
   * Structuur per entry:
   *   { store: 'GENTS Almere', branchId: '1', kind: 'retail' }
   *   kind: 'retail' | 'warehouse' | 'showroom' | 'admin'
   */
  branches: Object.freeze({
    list: Object.freeze([
      { store: 'GENTS Almere',       branchId: '1',  kind: 'retail'    },
      { store: 'GENTS Amersfoort',   branchId: '2',  kind: 'retail'    },
      { store: 'GENTS Amsterdam',    branchId: '5',  kind: 'retail'    },
      { store: 'GENTS Antwerpen',    branchId: '21', kind: 'retail'    },
      { store: 'GENTS Arnhem',       branchId: '3',  kind: 'retail'    },
      { store: 'GENTS Breda',        branchId: '4',  kind: 'retail'    },
      { store: 'GENTS Den Bosch',    branchId: '6',  kind: 'retail'    },
      { store: 'GENTS Delft',        branchId: '7',  kind: 'retail'    },
      { store: 'GENTS Enschede',     branchId: '8',  kind: 'retail'    },
      { store: 'GENTS Groningen',    branchId: '9',  kind: 'retail'    },
      { store: 'GENTS Hilversum',    branchId: '10', kind: 'retail'    },
      { store: 'GENTS Leiden',       branchId: '13', kind: 'retail'    },
      { store: 'GENTS Maastricht',   branchId: '14', kind: 'retail'    },
      { store: 'GENTS Nijmegen',     branchId: '15', kind: 'retail'    },
      { store: 'GENTS Rotterdam',    branchId: '16', kind: 'retail'    },
      { store: 'GENTS Tilburg',      branchId: '17', kind: 'retail'    },
      { store: 'GENTS Utrecht',      branchId: '18', kind: 'retail'    },
      { store: 'GENTS Zoetermeer',   branchId: '19', kind: 'retail'    },
      { store: 'GENTS Zwolle',       branchId: '20', kind: 'retail'    },
      { store: 'GENTS Magazijn',     branchId: '99', kind: 'warehouse' },
      { store: 'GENTS Magazijn-2',   branchId: '97', kind: 'warehouse' },
      { store: 'GENTS Showroom',     branchId: '700', kind: 'showroom' },
      { store: 'GENTS Brandstores',  branchId: '900', kind: 'admin'    }
    ])
    /* Wil je een nieuwe winkel toevoegen?
     *   1. Voeg toe aan de list hierboven met juiste branchId + kind
     *   2. Deploy storegents — frontend leest direct via /api/branches
     *   3. Check dat snapshot-cron de nieuwe branchId picked up
     */
  }),

  /**
   * ===========================================================
   * VOORRAAD-CORRECTIE
   * ===========================================================
   */
  stockCorrections: Object.freeze({
    /** Aantal werkdagen target om aanvragen af te handelen — voor KPI. */
    handlingDaysTarget: 3,
    /** Bij hoeveel stuks afwijking gaat een aanvraag als 'high-risk'? */
    highRiskAbsDiff: 5
  }),

  /**
   * ===========================================================
   * RAPPORTAGE-SCHEDULER
   * ===========================================================
   */
  reportScheduling: Object.freeze({
    /** Cron-frequentie waarmee de runner checkt op due schedules. */
    runnerSchedule: '0,15,30,45 * * * *', // elke 15 min
    /** Hoe vaak retry bij mail-fail per recipient. */
    mailRetryAttempts: 1
  })

});

/**
 * Convenience helpers — gebruik bij voorkeur deze functies ipv direct
 * uit BUSINESS_CONFIG lezen, zodat we later config-overrides via Blob
 * kunnen toevoegen zonder elke callsite te wijzigen.
 */

/** Lijst alle branches, optioneel gefilterd op kind. */
export function listBranchesFromConfig({ includeInternal = true } = {}) {
  const all = BUSINESS_CONFIG.branches.list;
  if (includeInternal) return [...all];
  return all.filter((b) => b.kind === 'retail');
}

/** Map branchId → store-naam. */
export function branchIdToStoreName(branchId) {
  const found = BUSINESS_CONFIG.branches.list.find((b) => b.branchId === String(branchId));
  return found?.store || '';
}

/** Is dit een warehouse/showroom/admin store? */
export function isInternalStore(storeName) {
  const found = BUSINESS_CONFIG.branches.list.find((b) => b.store === storeName);
  return found ? (found.kind !== 'retail') : false;
}

/** Validate of een email is toegestaan voor mail-recipients. */
export function isAllowedMailRecipient(email) {
  return BUSINESS_CONFIG.mail.allowedDomainRegex.test(String(email || '').trim());
}

/** Standaard pickup-deadline timestamp uit datum. */
export function dragerDeadlineFor(dateIso) {
  const d = new Date(dateIso);
  d.setHours(d.getHours() + BUSINESS_CONFIG.deadlines.dragerHours);
  return d.toISOString();
}

export default BUSINESS_CONFIG;
