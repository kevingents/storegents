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

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'config/cron-config.json';

/* Bekende crons — staat in vercel.json + extra metadata.
   Key = path-basename (laatste segment na /api/cron/). */
export const KNOWN_CRONS = [
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
    key: 'srs-cancellations-nightly',
    label: 'SRS annuleringen check',
    description: 'Checkt of orders in SRS geannuleerd zijn en sync de status.',
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
    key: 'srs-revenue-cache',
    label: 'SRS omzet-cache',
    description: 'Pre-aggregeert SRS transacties zodat dashboards snel laden.',
    defaultSchedule: '30 */2 * * *',
    defaultLabel: 'Elke 2 uur op :30',
    defaultMinIntervalMin: 120,
    impact: 'medium'
  },
  {
    key: 'monthly-omnichannel-winner',
    label: 'Maand-winnaar (omnichannel)',
    description: 'Bepaalt + mailt de winkel-winnaar van de maand.',
    defaultSchedule: '0 9 1 * *',
    defaultLabel: '1e van de maand 09:00 UTC',
    defaultMinIntervalMin: 24 * 60,
    impact: 'low'
  },
  {
    key: 'region-manager-weekly-report',
    label: 'Regio-manager weekrapport',
    description: 'Wekelijkse mailing naar regio-managers met store-stats.',
    defaultSchedule: '0 7 * * 1',
    defaultLabel: 'Maandag 07:00 UTC',
    defaultMinIntervalMin: 60 * 24 * 6,
    impact: 'medium'
  },
  {
    key: 'region-manager-weekly-drager-report',
    label: 'Regio-manager dragers',
    description: 'Wekelijkse dragers-rapport voor regio-managers.',
    defaultSchedule: '0 8 * * 1',
    defaultLabel: 'Maandag 08:00 UTC',
    defaultMinIntervalMin: 60 * 24 * 6,
    impact: 'low'
  },
  {
    key: 'google-reviews-snapshot',
    label: 'Google reviews snapshot',
    description: 'Dagelijkse snapshot van Google reviews per winkel.',
    defaultSchedule: '30 6 * * *',
    defaultLabel: 'Dagelijks om 06:30 UTC',
    defaultMinIntervalMin: 1440,
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
    key: 'shopify-offline-sync',
    label: 'Offline aankopen → Shopify',
    description: 'Synchroniseert SRS POS-transacties van de laatste 24u naar Shopify als orders (gents-offline tag).',
    defaultSchedule: '30 3 * * *',
    defaultLabel: 'Dagelijks om 03:30 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'medium'
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
    key: 'reserveringen-expire',
    label: 'Reserveringen verlopen',
    description: 'Sluit automatisch verlopen reserveringen.',
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
    key: 'shopify-products-refresh',
    label: 'Shopify producten cache',
    description: 'Verversing van de Shopify producten-cache voor de artikel-zoeker.',
    defaultSchedule: '0 3 * * *',
    defaultLabel: 'Dagelijks om 03:00 UTC',
    defaultMinIntervalMin: 1440,
    impact: 'low'
  }
];

export async function getAllCronConfigs() {
  return readJsonBlob(STORE_PATH, {});
}

export async function getCronConfig(key) {
  if (!key) return null;
  const all = await getAllCronConfigs();
  return all[String(key)] || null;
}

export async function setCronConfig(key, patch, updatedBy = 'admin') {
  const target = String(key || '').trim();
  if (!target) throw new Error('Cron key ontbreekt.');
  const all = await getAllCronConfigs();
  const existing = all[target] || {};
  const merged = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || 'admin')
  };
  all[target] = merged;
  await writeJsonBlob(STORE_PATH, all);
  return { key: target, ...merged };
}

/**
 * Record dat een cron net gerund heeft. Bij elke succesvolle of mislukte
 * cron-run aanroepen vanuit cron-guard.js.
 */
export async function recordCronRun(key, { status, durationMs, error, summary } = {}) {
  const target = String(key || '').trim();
  if (!target) return;
  const all = await getAllCronConfigs();
  const existing = all[target] || {};
  all[target] = {
    ...existing,
    lastRun: new Date().toISOString(),
    lastStatus: String(status || 'unknown'),
    lastDurationMs: Number(durationMs || 0),
    lastError: String(error || ''),
    lastSummary: summary || null,
    runCount: Number(existing.runCount || 0) + 1
  };
  await writeJsonBlob(STORE_PATH, all);
}

/**
 * Reset config voor 1 cron (=verwijder override, terug naar defaults).
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
 * Geeft de effectieve config terug voor een cron: defaults + overrides.
 */
export function getEffectiveCronConfig(key, override) {
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
  return {
    ...defaults,
    enabled: override?.enabled !== false, /* default true */
    minIntervalMin: Number(override?.minIntervalMin || defaults.defaultMinIntervalMin),
    lastRun: override?.lastRun || null,
    lastStatus: override?.lastStatus || null,
    lastDurationMs: Number(override?.lastDurationMs || 0),
    lastError: override?.lastError || '',
    lastSummary: override?.lastSummary || null,
    runCount: Number(override?.runCount || 0),
    updatedAt: override?.updatedAt || null,
    updatedBy: override?.updatedBy || null,
    hasOverride: Boolean(override)
  };
}
