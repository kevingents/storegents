/**
 * Report Schedules store.
 *
 * Beheert geplande rapport-runs. Elke schedule beschrijft:
 *  - welk rapport (reportKey, matcht report-data-fetchers)
 *  - over welke periode (today, week, month, etc. — relatief t.o.v. runtijd)
 *  - met welke frequentie (once / daily / weekly / monthly)
 *  - aan wie te mailen (alleen @gents.nl voor veiligheid)
 *  - in welk formaat (csv / pdf)
 *
 * De cron `/api/cron/run-report-schedules` checkt elke 15 minuten welke
 * schedules due zijn (`nextRun <= now`) en runt ze.
 *
 * Storage:
 *   config/report-schedules.json
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import crypto from 'node:crypto';

const STORE_PATH = 'config/report-schedules.json';

/* Beperkingen */
const MAX_RECIPIENTS = 10;
const MIN_HOUR = 0;
const MAX_HOUR = 23;
const ALLOWED_FREQUENCIES = new Set(['once', 'daily', 'weekly', 'monthly']);
const ALLOWED_PERIODS = new Set(['today', 'yesterday', 'week', 'month', 'quarter', 'year', 'last-7-days', 'last-30-days', 'last-90-days']);
const ALLOWED_FORMATS = new Set(['csv', 'pdf']);

/* @gents.nl-restrictie — voorkomt dat per ongeluk klant-data naar externe
   adressen gaat. Strikt: alleen @gents.nl (geen subdomains). */
const ALLOWED_EMAIL_RE = /^[a-z0-9._%+-]+@gents\.nl$/i;

function emptyState() {
  return {
    schedules: [],
    updatedAt: null
  };
}

function clean(v) { return String(v == null ? '' : v).trim(); }

export async function listSchedules() {
  const raw = await readJsonBlob(STORE_PATH, emptyState());
  return Array.isArray(raw?.schedules) ? raw.schedules : [];
}

async function writeSchedules(schedules) {
  await writeJsonBlob(STORE_PATH, {
    schedules,
    updatedAt: new Date().toISOString()
  });
  return schedules;
}

export function isAllowedRecipient(email) {
  return ALLOWED_EMAIL_RE.test(String(email || '').trim());
}

/**
 * Normaliseer + valideer een schedule-input. Throws bij ongeldige data.
 */
export function normalizeSchedule(input, existing = null) {
  const id = existing?.id || `sched_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
  const name = clean(input?.name);
  if (!name || name.length < 2) throw new Error('Naam is verplicht (min 2 tekens).');
  if (name.length > 80) throw new Error('Naam is te lang (max 80 tekens).');

  const reportKey = clean(input?.reportKey);
  if (!reportKey) throw new Error('Rapport-type is verplicht.');

  const period = clean(input?.period).toLowerCase() || 'last-7-days';
  if (!ALLOWED_PERIODS.has(period)) throw new Error(`Periode "${period}" wordt niet ondersteund.`);

  const frequency = clean(input?.frequency).toLowerCase() || 'weekly';
  if (!ALLOWED_FREQUENCIES.has(frequency)) throw new Error(`Frequentie "${frequency}" wordt niet ondersteund.`);

  const format = clean(input?.format).toLowerCase() || 'csv';
  if (!ALLOWED_FORMATS.has(format)) throw new Error(`Bestandsformaat "${format}" wordt niet ondersteund.`);

  /* Recipients: filter alleen @gents.nl, dedup, max MAX_RECIPIENTS */
  const rawRecipients = Array.isArray(input?.recipients)
    ? input.recipients
    : String(input?.recipients || '').split(/[,;\s]+/);
  const recipients = [...new Set(
    rawRecipients
      .map((r) => clean(r).toLowerCase())
      .filter(Boolean)
  )];
  for (const r of recipients) {
    if (!isAllowedRecipient(r)) {
      throw new Error(`E-mailadres "${r}" is niet toegestaan — alleen @gents.nl adressen zijn toegestaan.`);
    }
  }
  if (!recipients.length) throw new Error('Vul minimaal één ontvanger in.');
  if (recipients.length > MAX_RECIPIENTS) {
    throw new Error(`Te veel ontvangers — max ${MAX_RECIPIENTS}.`);
  }

  /* Stores: optioneel filter voor winkel-rapporten. Leeg = alle winkels. */
  const stores = Array.isArray(input?.stores)
    ? input.stores.map((s) => clean(s)).filter(Boolean)
    : [];

  /* Tijd-instellingen */
  const hourUtc = Number(input?.hourUtc);
  const hour = Number.isFinite(hourUtc) && hourUtc >= MIN_HOUR && hourUtc <= MAX_HOUR
    ? Math.floor(hourUtc)
    : 7; /* default 07:00 UTC = ~09:00 NL */

  const weekday = frequency === 'weekly'
    ? Math.min(6, Math.max(0, Number(input?.weekday) || 1)) /* 0=zo, 1=ma … 6=za */
    : null;
  const dayOfMonth = frequency === 'monthly'
    ? Math.min(28, Math.max(1, Number(input?.dayOfMonth) || 1)) /* cap op 28 om feb-issues te vermijden */
    : null;

  const enabled = input?.enabled !== false;

  const startAt = clean(input?.startAt); /* ISO datum voor "once" of vanaf-wanneer-actief */

  const now = new Date();
  const createdAt = existing?.createdAt || now.toISOString();
  const createdBy = existing?.createdBy || clean(input?.createdBy) || 'admin';

  const base = {
    id,
    name,
    reportKey,
    period,
    frequency,
    format,
    recipients,
    stores,
    hourUtc: hour,
    weekday,
    dayOfMonth,
    enabled,
    startAt: startAt || null,
    createdAt,
    createdBy,
    lastRun: existing?.lastRun || null,
    lastRunStatus: existing?.lastRunStatus || null,
    lastRunError: existing?.lastRunError || null,
    lastRunDownloadUrl: existing?.lastRunDownloadUrl || null,
    runCount: existing?.runCount || 0
  };

  base.nextRun = computeNextRun(base, now);
  return base;
}

/**
 * Bereken volgende run-moment voor een schedule.
 *
 * - once    : startAt (eenmalig) of nextRun = null (al uitgevoerd)
 * - daily   : volgende dag op hourUtc
 * - weekly  : volgende keer dat het weekday + hourUtc raakt
 * - monthly : volgende keer dat dayOfMonth + hourUtc raakt
 */
export function computeNextRun(schedule, fromDate = new Date()) {
  const now = new Date(fromDate);

  if (!schedule.enabled) return null;

  if (schedule.frequency === 'once') {
    if (schedule.lastRun) return null; /* al gerund */
    if (schedule.startAt) return new Date(schedule.startAt).toISOString();
    /* Default: zo snel mogelijk */
    return now.toISOString();
  }

  /* Voor daily/weekly/monthly: bouw kandidaat-tijdstip in UTC en zoek
     eerste future moment dat past bij de frequency-regels. */
  const candidate = new Date(now);
  candidate.setUTCHours(schedule.hourUtc, 0, 0, 0);

  if (schedule.frequency === 'daily') {
    if (candidate <= now) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate.toISOString();
  }

  if (schedule.frequency === 'weekly') {
    const targetDay = Number.isFinite(schedule.weekday) ? schedule.weekday : 1;
    while (candidate.getUTCDay() !== targetDay || candidate <= now) {
      candidate.setUTCDate(candidate.getUTCDate() + 1);
    }
    return candidate.toISOString();
  }

  if (schedule.frequency === 'monthly') {
    const targetDom = Number.isFinite(schedule.dayOfMonth) ? schedule.dayOfMonth : 1;
    candidate.setUTCDate(targetDom);
    if (candidate <= now) {
      candidate.setUTCMonth(candidate.getUTCMonth() + 1);
      candidate.setUTCDate(targetDom);
    }
    return candidate.toISOString();
  }

  return null;
}

export async function createSchedule(input) {
  const schedules = await listSchedules();
  const sched = normalizeSchedule(input);
  schedules.push(sched);
  await writeSchedules(schedules);
  return sched;
}

export async function updateSchedule(id, patch) {
  const schedules = await listSchedules();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error('Schedule niet gevonden.');
  const merged = { ...schedules[idx], ...patch };
  const sched = normalizeSchedule(merged, schedules[idx]);
  schedules[idx] = sched;
  await writeSchedules(schedules);
  return sched;
}

export async function deleteSchedule(id) {
  const schedules = await listSchedules();
  const filtered = schedules.filter((s) => s.id !== id);
  if (filtered.length === schedules.length) throw new Error('Schedule niet gevonden.');
  await writeSchedules(filtered);
  return true;
}

/**
 * Markeer een run als afgerond (gelukt of mislukt) en herbereken nextRun.
 */
export async function recordRun(id, { status, error, downloadUrl }) {
  const schedules = await listSchedules();
  const idx = schedules.findIndex((s) => s.id === id);
  if (idx < 0) throw new Error('Schedule niet gevonden.');
  const sched = schedules[idx];
  sched.lastRun = new Date().toISOString();
  sched.lastRunStatus = status === 'ok' ? 'ok' : 'error';
  sched.lastRunError = status === 'ok' ? null : String(error || 'Onbekende fout');
  sched.lastRunDownloadUrl = downloadUrl || null;
  sched.runCount = Number(sched.runCount || 0) + 1;
  /* Voor once-schedules: na 1 run niet meer plannen */
  if (sched.frequency === 'once') {
    sched.enabled = false;
    sched.nextRun = null;
  } else {
    sched.nextRun = computeNextRun(sched, new Date());
  }
  schedules[idx] = sched;
  await writeSchedules(schedules);
  return sched;
}

/**
 * Lijst alle schedules die op `now` due zijn.
 */
export async function findDueSchedules(now = new Date()) {
  const schedules = await listSchedules();
  return schedules.filter((s) => {
    if (!s.enabled) return false;
    if (!s.nextRun) return false;
    return new Date(s.nextRun).getTime() <= now.getTime();
  });
}

/**
 * Constants voor frontend (geëxporteerd zodat de UI dezelfde waarden gebruikt).
 */
export const SCHEDULE_LIMITS = {
  MAX_RECIPIENTS,
  ALLOWED_PERIODS: [...ALLOWED_PERIODS],
  ALLOWED_FREQUENCIES: [...ALLOWED_FREQUENCIES],
  ALLOWED_FORMATS: [...ALLOWED_FORMATS],
  emailDomain: '@gents.nl'
};
