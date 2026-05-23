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
export async function recordCronRun(key, { status, durationMs, error, summary } = {}) {
  const target = String(key || '').trim();
  if (!target) return;
  const existing = await readJsonBlob(runsPathFor(target), {});
  const next = {
    key: target,
    lastRun: new Date().toISOString(),
    lastStatus: String(status || 'unknown'),
    lastDurationMs: Number(durationMs || 0),
    lastError: String(error || ''),
    lastSummary: summary || null,
    runCount: Number(existing.runCount || 0) + 1
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
    runCount: Number(rs.runCount ?? override?.runCount ?? 0),
    updatedAt: override?.updatedAt || null,
    updatedBy: override?.updatedBy || null,
    hasOverride: Boolean(override)
  };
}
