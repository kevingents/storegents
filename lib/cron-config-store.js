/**
 * Cron-config store: admin-overrides voor cron-jobs.
 *
 * Vercel cron schedules zijn statisch (vercel.json) en kunnen niet runtime
 * gewijzigd worden. Wat we WEL kunnen is een software-laag toevoegen die per
 * cron-execution checkt of de admin de cron heeft uitgezet, of dat er een
 * lagere frequentie is ingesteld dan de Vercel-schedule.
 *
 * Schema (Blob: config/cron-config.json):
 *   {
 *     "daily-loyalty-vouchers": {
 *       "enabled": true,
 *       "minIntervalMin": 1440,    // 1440 = 24 uur (skip als <)
 *       "lastRun": "2026-05-20T06:00:00.000Z",
 *       "lastStatus": "success",
 *       "lastDurationMs": 4321,
 *       "lastError": "",
 *       "updatedAt": "...",
 *       "updatedBy": "admin"
 *     },
 *     ...
 *   }
 *
 * Belangrijk:
 *   - Een hogere frequentie dan Vercel runt is NIET mogelijk (cron blijft
 *     op zijn vaste schedule)
 *   - Een lagere frequentie werkt door minIntervalMin te zetten — de cron
 *     skipt zichzelf als de laatste run te recent is
 *   - enabled=false stopt de cron volledig
 */

import { list } from '@vercel/blob';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'config/cron-config.json';
/* Aparte blob-prefix voor run-state (lastRun/lastStatus/duration). Eén file
   PER cron-key, dus geen race-condition als meerdere crons tegelijk eindigen.
   De centrale STORE_PATH is alleen nog voor admin-overrides (enabled,
   minIntervalMin) die zelden geschreven worden. */
const RUNS_PREFIX = 'config/cron-runs/';
function runsPathFor(key) { return `${RUNS_PREFIX}${String(key || '').trim()}.json`; }

/* Bekende crons — bron-van-waarheid voor het cron-overzicht in admin. Geeft
   per cron-key (= argument van trackedCron() én meestal path-basename) een
   menselijk label, omschrijving en de defaultMinIntervalMin die guards gebruiken
   wanneer er geen admin-override is ingesteld.

   Houd in sync met vercel.json + de trackedCron('<key>', …) calls.

   defaultMinIntervalMin = ondergrens voor cron-guard. Stelt voor de hoogste
   geldige frequentie (bv. een 5-min cron krijgt 5; daaronder wordt geskipt). */
export const KNOWN_CRONS = [
  /* ─── Notifications & user-mail ──────────────────────────────────── */
  {
    key: 'daily-loyalty-vouchers',
    label: 'Loyalty vouchers',
    description: 'Maakt automatisch vouchers aan voor klanten met genoeg punten + mailt ze.',
    defaultSchedule: '0 6 * * *',
    defaultLabel: 'Dagelijks om 06:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'high'
  },
  {
    key: 'voucher-reminders',
    label: 'Voucher reminders',
    description: 'Stuurt herinneringsmails naar klanten met openstaande vouchers die binnenkort verlopen.',
    defaultSchedule: '0 8 * * *',
    defaultLabel: 'Dagelijks om 08:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'pickup-mail-run',
    label: 'Afhaalorders herinnering',
    description: 'Stuurt herinneringen naar klanten die hun afhaalorder nog niet hebben opgehaald.',
    defaultSchedule: '0 8 * * 1-6',
    defaultLabel: 'Ma–za 08:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'high'
  },
  {
    key: 'weborder-mail-run',
    label: 'Te-late orders mail',
    description: 'Stuurt winkels een overzicht van orders die te lang openstaan.',
    defaultSchedule: '0 8 * * *',
    defaultLabel: 'Dagelijks om 08:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'drager-mail-run',
    label: 'Openstaande dragers mail',
    description: 'Tijdelijk uitgeschakeld — SRS-drager koppeling niet stabiel.',
    defaultSchedule: '10 8 * * *',
    defaultLabel: 'Dagelijks om 08:10 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low',
    triggerDisabled: true
  },
  {
    key: 'birthday-notifications',
    label: 'Verjaardags-notificaties',
    description: 'Mailt winkels op de verjaardagen van hun medewerkers.',
    defaultSchedule: '0 7 * * *',
    defaultLabel: 'Dagelijks om 07:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'customer-mail-run',
    label: 'Klantenrapport mail',
    description: 'Volledig klanten-overzicht naar winkel-mails + extra ontvangers. Weekly (ma 08:30 UTC, deze maand t/m vandaag) en monthly (2e v/d maand 09:00 UTC, vorige maand + nieuwe targets).',
    defaultSchedule: '30 8 * * 1 + 0 9 2 * *',
    defaultLabel: 'Ma 08:30 UTC + 2e v/d maand 09:00 UTC',
    defaultMinIntervalMin: 60 * 24,
    impact: 'high'
  },
  {
    key: 'taken-reminders',
    label: 'Takenplanner reminders',
    description: 'Genereert nieuwe taak-instanties op basis van schedules + mailt assignees over openstaande/aankomende taken.',
    defaultSchedule: '30 6 * * *',
    defaultLabel: 'Dagelijks om 06:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'automations:birthday',
    label: 'Automation: Verjaardag',
    description: 'Stuurt verjaardagsmail naar klanten (per-winkel afzender via Resend). Slaat skip over als de registry-automation uit staat.',
    defaultSchedule: '0 8 * * *',
    defaultLabel: 'Dagelijks om 08:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'automations:winback',
    label: 'Automation: Win-back',
    description: 'Mailt inactieve klanten (geen aankoop sinds X dagen) een win-back-aanbieding.',
    defaultSchedule: '30 9 * * *',
    defaultLabel: 'Dagelijks om 09:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'automations:replenishment',
    label: 'Automation: Replenishment',
    description: 'Mailt klanten die normaal nu een nieuwe aankoop zouden doen (op basis van eerdere koop-frequentie).',
    defaultSchedule: '0 10 * * *',
    defaultLabel: 'Dagelijks om 10:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'automations:custom',
    label: 'Automation: Custom regels',
    description: 'Draait alle door admin/AI geconfigureerde custom-automations in één run.',
    defaultSchedule: '30 10 * * *',
    defaultLabel: 'Dagelijks om 10:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'automation-new-collection',
    label: 'Automation: Nieuwe collectie',
    description: 'Detecteert nieuwe Shopify-collecties en mailt aankondigingen waar geconfigureerd.',
    defaultSchedule: '20 9 * * *',
    defaultLabel: 'Dagelijks om 09:20 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },

  /* ─── SRS & inventory ────────────────────────────────────────────── */
  {
    key: 'srs-cancellations-nightly',
    label: 'SRS annuleringen check (rolling)',
    description: 'Misleidende naam — draait elk uur op :15 met branch-rotatie via nextIndex. Checkt of orders in SRS geannuleerd zijn en synct de status.',
    defaultSchedule: '15 * * * *',
    defaultLabel: 'Elke uur op :15',
    defaultMinIntervalMin: 60,
    impact: 'high'
  },
  {
    key: 'srs-unavailable-hourly',
    label: 'Niet-leverbaar check',
    description: 'Checkt niet-leverbare orderregels en stuurt alerts.',
    defaultSchedule: '20 * * * *',
    defaultLabel: 'Elke uur op :20',
    defaultMinIntervalMin: 60,
    impact: 'high'
  },
  {
    key: 'srs-unavailable-lost-found-check',
    label: 'Niet-leverbaar verlies/gevonden check',
    description: 'Checkt niet-leverbare orderregels op verlies/gevonden-status en stuurt alerts.',
    defaultSchedule: '30 6 * * 1,2',
    defaultLabel: 'Ma en di om 06:30 UTC',
    defaultMinIntervalMin: 60 * 24,
    impact: 'medium'
  },
  {
    key: 'srs-revenue-cache',
    label: 'SRS omzet-cache',
    description: 'Pre-aggregeert SRS transacties zodat dashboards snel laden.',
    defaultSchedule: '30 */2 * * *',
    defaultLabel: 'Elke 2 uur op :30',
    defaultMinIntervalMin: 120,
    impact: 'medium'
  },
  {
    key: 'srs-cache-refresh',
    label: 'SRS weborders-cache refresh',
    description: 'Ververst de weborders-cache zodat winkels snel openstaand zien.',
    defaultSchedule: '*/10 6-22 * * 1-6',
    defaultLabel: 'Elke 10 min ma-za 06-22 UTC',
    defaultMinIntervalMin: 10,
    impact: 'medium'
  },
  {
    key: 'srs-historic-backfill',
    label: 'SRS historic backfill',
    description: 'Vult historische transacties bij voor recente dagen (correctheid rond middernacht).',
    defaultSchedule: '0 1 * * *',
    defaultLabel: 'Dagelijks om 01:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'srs-stock-delta-import',
    label: 'SRS voorraad delta-import',
    description: 'Elke 5 min daytime de delta + dagelijks 02:30 full re-import (mode=full).',
    defaultSchedule: '*/5 6-22 * * * + 30 2 * * *',
    defaultLabel: 'Elke 5 min 06-22 UTC + nightly full',
    defaultMinIntervalMin: 5,
    impact: 'high'
  },
  {
    key: 'srs-voorraad-import',
    label: 'SRS voorraad SFTP-import',
    description: '3x per dag: leest het laatste voorraad-CSV-bestand via SFTP en bouwt de snapshot.',
    defaultSchedule: '0 5,11,15 * * *',
    defaultLabel: '05:00, 11:00, 15:00 UTC',
    defaultMinIntervalMin: 240,
    impact: 'high'
  },
  {
    key: 'srs-retail-import',
    label: 'SRS retail SFTP-import',
    description: 'Dagelijks: leest verkoop-CSV via SFTP en bouwt de retail-ledger (basis voor winkel-omzet + KPIs).',
    defaultSchedule: '20 5 * * *',
    defaultLabel: 'Dagelijks om 05:20 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'high'
  },
  {
    key: 'stock-reconcile',
    label: 'Voorraad SRS↔Shopify reconcile',
    description: 'Vergelijkt SRS-magazijn met Shopify voorraad en signaleert verschillen (per SKU). Draait NA de voorraad-import (05:00 UTC) zodat het verse SRS-data gebruikt i.p.v. de gisteren-laatste.',
    defaultSchedule: '30 5 * * *',
    defaultLabel: 'Dagelijks om 05:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'merchandiser-snapshot',
    label: 'Merchandiser snapshot',
    description: 'Dagelijkse snapshot voor herverdeling/misgrijpen/doorverkoop. Draait na voorraad + retail-import.',
    defaultSchedule: '40 5 * * *',
    defaultLabel: 'Dagelijks om 05:40 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'retail-anomaly-check',
    label: 'Retail anomaly-check',
    description: 'Checkt of de voorraad+retail-import van vandaag binnen verwachtingsranges valt; signaleert anomalies.',
    defaultSchedule: '50 5 * * *',
    defaultLabel: 'Dagelijks om 05:50 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'supplychain-daily-metrics',
    label: 'Supply chain dagelijkse metrics',
    description: 'Bouwt dagelijkse supply-chain metric-snapshot voor het dashboard.',
    defaultSchedule: '30 4 * * *',
    defaultLabel: 'Dagelijks om 04:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'srs-cancelled-backfill-2026',
    label: 'SRS cancelled backfill 2026 (handmatig)',
    description: 'Eenmalige/handmatige backfill — niet in vercel.json. Triggered via admin om ontbrekende cancellation-state op te halen.',
    defaultSchedule: '',
    defaultLabel: 'Alleen handmatig',
    defaultMinIntervalMin: 1440,
    impact: 'low',
    triggerDisabled: true
  },

  /* ─── Shopify sync ────────────────────────────────────────────────── */
  {
    key: 'sync-shopify-points',
    label: 'Shopify punten-sync',
    description: 'Synct SRS loyalty-punten naar Shopify customer metafields.',
    defaultSchedule: '0 6 * * *',
    defaultLabel: 'Dagelijks om 06:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'sync-google-opening-hours',
    label: 'Google openingstijden sync',
    description: 'Synct openingstijden van Google Business Profile naar Shopify metafields.',
    defaultSchedule: '0 2 * * *',
    defaultLabel: 'Dagelijks om 02:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'shopify-offline-sync',
    label: 'Offline aankopen → Shopify',
    description: 'Synchroniseert SRS POS-transacties van de laatste 24u naar Shopify als orders (gents-offline tag).',
    defaultSchedule: '30 3 * * *',
    defaultLabel: 'Dagelijks om 03:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'shopify-products-refresh',
    label: 'Shopify producten cache',
    description: 'Verversing van de Shopify producten-cache voor de artikel-zoeker.',
    defaultSchedule: '0 3 * * *',
    defaultLabel: 'Dagelijks om 03:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },

  /* ─── Marketing & content ────────────────────────────────────────── */
  {
    key: 'google-reviews-snapshot',
    label: 'Google reviews snapshot',
    description: 'Dagelijkse snapshot van Google reviews per winkel.',
    defaultSchedule: '0 4 * * *',
    defaultLabel: 'Dagelijks om 04:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'content-new-product-check',
    label: 'Nieuwe producten check',
    description: 'Detecteert pas-gepubliceerde Shopify producten en kondigt ze aan (interne notif/content-suggesties).',
    defaultSchedule: '30 3 * * *',
    defaultLabel: 'Dagelijks om 03:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'content-calendar-tips',
    label: 'Content-kalender tips',
    description: 'Genereert content-suggesties (weer/verkoop/seizoen/AI) per dag voor de marketing-kalender.',
    defaultSchedule: '15 6 * * *',
    defaultLabel: 'Dagelijks om 06:15 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'spotler-metrics-refresh',
    label: 'Spotler metrics refresh',
    description: 'Haalt nieuwste mailing-stats uit Spotler/MailPlus en cachet de geaggregeerde rates.',
    defaultSchedule: '45 5 * * *',
    defaultLabel: 'Dagelijks om 05:45 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'spotler-audience-sync',
    label: 'Spotler audience-sync',
    description: 'Sync klanten met mail-toestemming naar Spotler audience.',
    defaultSchedule: '50 5 * * *',
    defaultLabel: 'Dagelijks om 05:50 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'resend-audience-sync',
    label: 'Resend audience-sync',
    description: 'Dagelijkse full sync om 05:55 + incremental sync elke 2 uur (?inc=1) zodat nieuwe klanten direct in Resend audience komen.',
    defaultSchedule: '55 5 * * * + 0 */2 * * *',
    defaultLabel: 'Dagelijks + elke 2 uur incremental',
    defaultMinIntervalMin: 60,
    impact: 'low'
  },
  {
    key: 'beeldbank-classify',
    label: 'Beeldbank AI-classify',
    description: 'Classificeert nieuwe beeldbank-assets via Claude Vision (modelhint, sfeer, tags).',
    defaultSchedule: '30 6 * * *',
    defaultLabel: 'Dagelijks om 06:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'product-audit',
    label: 'Product audit',
    description: 'Dagelijkse audit van Shopify producten op compleetheid (beschrijving, foto, metafields).',
    defaultSchedule: '40 3 * * *',
    defaultLabel: 'Dagelijks om 03:40 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'seo-audit',
    label: 'SEO audit',
    description: 'Dagelijkse SEO-audit (titles, meta, broken links) van Shopify content.',
    defaultSchedule: '55 3 * * *',
    defaultLabel: 'Dagelijks om 03:55 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'ai-visibility',
    label: 'AI-zichtbaarheid scan',
    description: 'Checkt hoe GENTS zichtbaar is in AI-zoekresultaten (Perplexity/Claude/ChatGPT).',
    defaultSchedule: '5 4 * * *',
    defaultLabel: 'Dagelijks om 04:05 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'gala-crawl',
    label: 'Gala-events crawl',
    description: 'Wekelijkse crawl van gala/event-kalenders voor sales-planning.',
    defaultSchedule: '40 6 * * 1',
    defaultLabel: 'Maandag 06:40 UTC',
    defaultMinIntervalMin: 60 * 24 * 6,
    impact: 'low'
  },

  /* ─── Operations & monitoring ────────────────────────────────────── */
  {
    key: 'system-health-monitor',
    label: 'System health monitor',
    description: 'Elke 5 min: check de bestaande health-check endpoint, stuur alerts bij ernstige fouten.',
    defaultSchedule: '*/5 * * * *',
    defaultLabel: 'Elke 5 min',
    defaultMinIntervalMin: 5,
    impact: 'high'
  },
  {
    key: 'new-order-watcher',
    label: 'Nieuwe orders watcher',
    description: 'Elke 5 min: detecteert nieuwe afhaal/web-orders en push-notificeert betrokken winkels.',
    defaultSchedule: '*/5 * * * *',
    defaultLabel: 'Elke 5 min',
    defaultMinIntervalMin: 5,
    impact: 'high'
  },
  {
    key: 'kpi-alerts',
    label: 'KPI alerts',
    description: 'Dagelijkse evaluatie van KPI-targets; mailt admin als KPIs onder drempel zakken.',
    defaultSchedule: '0 7 * * *',
    defaultLabel: 'Dagelijks om 07:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'high'
  },
  {
    key: 'alert-rules-eval',
    label: 'Slimme alerts evaluatie',
    description: 'Elk uur: evalueert door admin/AI gemaakte slimme alert-regels in de Takenplanner.',
    defaultSchedule: '0 * * * *',
    defaultLabel: 'Elk uur op :00',
    defaultMinIntervalMin: 60,
    impact: 'medium'
  },
  {
    key: 'reserveringen-expire',
    label: 'Reserveringen verlopen',
    description: 'Sluit automatisch verlopen reserveringen (NL-tijdzone).',
    defaultSchedule: '0 6 * * *',
    defaultLabel: 'Dagelijks om 06:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'store-insights-builder',
    label: 'Winkel-insights cache',
    description: 'Bouwt dagelijkse inzichten per winkel (KPIs, trends) voor dashboards.',
    defaultSchedule: '0 3 * * *',
    defaultLabel: 'Dagelijks om 03:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'monthly-omnichannel-winner',
    label: 'Maand-winnaar (omnichannel)',
    description: 'Bepaalt + mailt de winkel-winnaar van de maand.',
    defaultSchedule: '0 8 1 * *',
    defaultLabel: '1e van de maand 08:00 UTC',
    defaultMinIntervalMin: 24 * 60,
    impact: 'low'
  },
  {
    key: 'region-manager-weekly-report',
    label: 'Regio-manager weekrapport',
    description: 'Wekelijkse mailing naar regio-managers met store-stats.',
    defaultSchedule: '0 8 * * *',
    defaultLabel: 'Dagelijks 08:00 UTC',
    defaultMinIntervalMin: 60 * 24,
    impact: 'medium'
  },
  {
    key: 'region-manager-weekly-drager-report',
    label: 'Regio-manager dragers',
    description: 'Dagelijks dragers-rapport voor regio-managers.',
    defaultSchedule: '15 8 * * *',
    defaultLabel: 'Dagelijks 08:15 UTC',
    defaultMinIntervalMin: 60 * 24,
    impact: 'low'
  },
  {
    key: 'students-vereniging-rebuild',
    label: 'Students vereniging-cache',
    description: 'Scant alle SRS klanten paginated en bouwt customerId→vereniging map. Voorraad voor Students-omzet pagina.',
    defaultSchedule: '0 3 * * *',
    defaultLabel: 'Dagelijks om 03:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'report-snapshots',
    label: 'Rapportage snapshots',
    description: 'Dagelijkse snapshot van rapporten voor historische trends in de rapport-bouwer.',
    defaultSchedule: '0 3 * * *',
    defaultLabel: 'Dagelijks om 03:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'run-report-schedules',
    label: 'Geplande rapportages',
    description: 'Elke 15 min: stuurt geplande rapport-distributies naar ontvangers.',
    defaultSchedule: '0,15,30,45 * * * *',
    defaultLabel: 'Elke 15 min',
    defaultMinIntervalMin: 15,
    impact: 'high'
  },
  {
    key: 'overdue-snapshot',
    label: 'Overdue snapshot',
    description: 'Dagelijkse snapshot van te-late orders per winkel voor week-/maandrapporten.',
    defaultSchedule: '45 7 * * *',
    defaultLabel: 'Dagelijks om 07:45 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'top-customers-snapshot',
    label: 'Top-klanten snapshot',
    description: 'Dagelijkse snapshot van top-klanten per winkel voor rapporten.',
    defaultSchedule: '0 5 * * *',
    defaultLabel: 'Dagelijks om 05:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },

  /* ─── Bol.com koppeling ──────────────────────────────────────────── */
  {
    key: 'bol-returns',
    label: 'Bol retouren sync',
    description: 'Dagelijkse import van Bol-retouren naar de centrale retour-flow.',
    defaultSchedule: '20 4 * * *',
    defaultLabel: 'Dagelijks om 04:20 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
  },
  {
    key: 'bol-content',
    label: 'Bol product-content sync',
    description: 'Pusht Shopify product-content (titels, beschrijving) naar Bol listings.',
    defaultSchedule: '25 4 * * *',
    defaultLabel: 'Dagelijks om 04:25 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'bol-stock',
    label: 'Bol voorraad sync',
    description: '05:40 UTC mapping (?map=1) + om 12:00 en 18:00 UTC voorraad-update naar Bol.',
    defaultSchedule: '40 5 * * * + 0 12,18 * * *',
    defaultLabel: '3x per dag (mapping + 2x stock)',
    defaultMinIntervalMin: 360,
    impact: 'high'
  },
  {
    key: 'bol-insights',
    label: 'Bol insights snapshot',
    description: 'Dagelijkse snapshot van Bol verkoop/views per artikel.',
    defaultSchedule: '30 6 * * *',
    defaultLabel: 'Dagelijks om 06:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  },
  {
    key: 'bol-orders',
    label: 'Bol orders import',
    description: '4x per dag: importeert nieuwe Bol-orders en cachet ze in marketplace/bol-orders.json.',
    defaultSchedule: '0 7,11,15,19 * * *',
    defaultLabel: '07:00, 11:00, 15:00, 19:00 UTC',
    defaultMinIntervalMin: 240,
    impact: 'high'
  },
  {
    key: 'bol-shopify-sync',
    label: 'Bol → Shopify push',
    description: '30 min na bol-orders: pusht nieuwe Bol-orders als Shopify-orders (financial_status=paid, tag bol-marketplace) zodat inventory wordt afgeschreven. Idempotent via bol-id-{orderId} tag + pushed-state blob.',
    defaultSchedule: '30 7,11,15,19 * * *',
    defaultLabel: '07:30, 11:30, 15:30, 19:30 UTC',
    defaultMinIntervalMin: 240,
    impact: 'high'
  }
];

export async function getAllCronConfigs() {
  return readJsonBlob(STORE_PATH, {});
}

/**
 * Geeft de gemerged config (admin-override + per-cron run-state) voor 1 cron.
 * cron-guard.js gebruikt dit voor rate-limiting (heeft lastRun nodig).
 */
export async function getCronConfig(key) {
  if (!key) return null;
  const target = String(key);
  const [all, runState] = await Promise.all([
    getAllCronConfigs(),
    getCronRunState(target)
  ]);
  const override = all[target];
  if (!override && !runState) return null;
  return { ...(override || {}), ...(runState || {}) };
}

export async function setCronConfig(key, patch, updatedBy = 'admin') {
  const target = String(key || '').trim();
  if (!target) throw new Error('Cron key ontbreekt.');
  const all = await getAllCronConfigs();
  const existing = all[target] || {};
  /* Alleen admin-override fields in centrale blob — run-state heeft eigen blob. */
  const cleanPatch = {};
  if (typeof patch.enabled === 'boolean') cleanPatch.enabled = patch.enabled;
  if (patch.minIntervalMin !== undefined) cleanPatch.minIntervalMin = patch.minIntervalMin;
  const merged = {
    ...existing,
    ...cleanPatch,
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || 'admin')
  };
  all[target] = merged;
  await writeJsonBlob(STORE_PATH, all);
  return { key: target, ...merged };
}

/**
 * Record dat een cron net gerund heeft. Schrijft naar 1 blob PER cron
 * (config/cron-runs/<key>.json) zodat meerdere crons tegelijk kunnen
 * eindigen zonder elkaars run-state te overschrijven. Centrale
 * config-blob blijft onaangeroerd → admin-overrides behouden.
 */
/* Hoeveel recente runs bewaren we per cron voor trend-grafiek? 50 is genoeg
   voor ~2 dagen uurlijkse crons of ~1.5 maand dagelijkse — past makkelijk
   in 1 blob-write. */
const RECENT_RUNS_KEEP = 50;

export async function recordCronRun(key, { status, durationMs, error, summary } = {}) {
  const target = String(key || '').trim();
  if (!target) return;
  const existing = await readJsonBlob(runsPathFor(target), {});
  const nowIso = new Date().toISOString();
  /* Ringbuffer: laatste N runs voor trend-analyse. Bij volle buffer rolt
     de oudste eruit. Houdt timestamp/status/duration/summary per run. */
  const recent = Array.isArray(existing.recentRuns) ? existing.recentRuns.slice(-(RECENT_RUNS_KEEP - 1)) : [];
  recent.push({
    at: nowIso,
    status: String(status || 'unknown'),
    durationMs: Number(durationMs || 0),
    error: String(error || '').slice(0, 200),
    summary: summary || null
  });
  const next = {
    key: target,
    lastRun: nowIso,
    lastStatus: String(status || 'unknown'),
    lastDurationMs: Number(durationMs || 0),
    lastError: String(error || ''),
    lastSummary: summary || null,
    runCount: Number(existing.runCount || 0) + 1,
    recentRuns: recent
  };
  await writeJsonBlob(runsPathFor(target), next);
}

/**
 * Lees run-state voor 1 cron uit per-cron blob.
 */
export async function getCronRunState(key) {
  const target = String(key || '').trim();
  if (!target) return null;
  const data = await readJsonBlob(runsPathFor(target), {});
  return data && Object.keys(data).length ? data : null;
}

/**
 * Lees alle run-states in 1 call: list() blobs onder config/cron-runs/
 * en fetch ze parallel.
 */
export async function getAllCronRunStates() {
  try {
    const result = await list({ prefix: RUNS_PREFIX, limit: 1000 });
    const blobs = (result.blobs || []).filter((b) => b.pathname.endsWith('.json'));
    const states = await Promise.all(blobs.map(async (b) => {
      try {
        const r = await fetch(b.url);
        if (!r.ok) return null;
        const txt = await r.text();
        const data = JSON.parse(txt || '{}');
        const key = b.pathname.slice(RUNS_PREFIX.length, -5); /* strip prefix + .json */
        return { key, ...data };
      } catch (_e) { return null; }
    }));
    const map = {};
    for (const s of states) { if (s && s.key) map[s.key] = s; }
    return map;
  } catch (error) {
    console.warn('[getAllCronRunStates] list-fail:', error.message);
    return {};
  }
}

/**
 * Reset config voor 1 cron (=verwijder override, terug naar defaults).
 * Verwijdert ALLEEN admin-override; run-state-blob blijft staan voor historie.
 */
export async function resetCronConfig(key) {
  const target = String(key || '').trim();
  if (!target) return;
  const all = await getAllCronConfigs();
  delete all[target];
  await writeJsonBlob(STORE_PATH, all);
  return { key: target, reset: true };
}

/**
 * Geeft de effectieve config terug voor een cron: defaults + overrides + runState.
 * Run-state komt uit eigen per-cron blob (zie getCronRunState).
 */
export function getEffectiveCronConfig(key, override, runState) {
  const known = KNOWN_CRONS.find((c) => c.key === key);
  const defaults = known || {
    key,
    label: key,
    description: '',
    defaultSchedule: '',
    defaultLabel: '',
    defaultMinIntervalMin: 60,
    impact: 'low'
  };
  /* Legacy: vroeger stond run-state ook in de override-blob. Fallback nemen
     we mee zodat oude entries niet verdwijnen voordat eerste recordCronRun
     ze migreert naar de per-key blob. */
  const rs = runState || {};
  return {
    ...defaults,
    enabled: override?.enabled !== false, /* default true */
    minIntervalMin: Number(override?.minIntervalMin || defaults.defaultMinIntervalMin),
    lastRun: rs.lastRun || override?.lastRun || null,
    lastStatus: rs.lastStatus || override?.lastStatus || null,
    lastDurationMs: Number(rs.lastDurationMs ?? override?.lastDurationMs ?? 0),
    lastError: rs.lastError || override?.lastError || '',
    lastSummary: rs.lastSummary || override?.lastSummary || null,
    recentRuns: Array.isArray(rs.recentRuns) ? rs.recentRuns : (Array.isArray(override?.recentRuns) ? override.recentRuns : []),
    runCount: Number(rs.runCount ?? override?.runCount ?? 0),
    updatedAt: override?.updatedAt || null,
    updatedBy: override?.updatedBy || null,
    hasOverride: Boolean(override)
  };
}
