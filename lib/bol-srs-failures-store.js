/**
 * lib/bol-srs-failures-store.js
 *
 * Houdt bij welke Bol-orders bij de SRS-push faalden, met laatste error +
 * attempt-count. Drijft 3 features:
 *   1. UI rode badge per order ("Fout: SRS extended attribute") i.p.v. "Wachten"
 *   2. Counter-tile "Fouten" op stat-bar
 *   3. Mail-notificatie aan beheerders na cron-run met nieuwe failures
 *
 * Blob: marketplace/bol-srs-failures.json
 *   {
 *     failed: {
 *       "C00066D7FM": {
 *         bolOrderId: "C00066D7FM",
 *         error: "SRS SOAP fault: 107-Problem adding order...",
 *         lastAttemptedAt: "2026-06-04T13:29:00Z",
 *         attemptCount: 3,
 *         lastSrsOrderId: "BOL-0005"  // ordernummer dat was gereserveerd
 *       }
 *     },
 *     updatedAt: "...",
 *     runCount: N
 *   }
 *
 * Auto-clear bij success-push (in bol-srs-push.js).
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'marketplace/bol-srs-failures.json';
const MAX_FAILED = 500;

const clean = (v) => String(v == null ? '' : v).trim();

export async function readBolSrsFailures() {
  const data = await readJsonBlob(PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.failed && typeof data.failed === 'object') return data;
  return { failed: {}, updatedAt: null, runCount: 0 };
}

/** Markeer 1 order als failed; verhoog attempt-count als al bekend. */
export async function recordBolSrsFailure(bolOrderId, { error, srsOrderId = '' } = {}) {
  const id = clean(bolOrderId);
  if (!id) return;
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { failed: { ...(cur.failed || {}) }, runCount: Number(cur.runCount) || 0 }
      : { failed: {}, runCount: 0 };
    const prev = data.failed[id] || {};
    data.failed[id] = {
      bolOrderId: id,
      error: clean(error).slice(0, 1500),
      lastAttemptedAt: new Date().toISOString(),
      attemptCount: (Number(prev.attemptCount) || 0) + 1,
      lastSrsOrderId: clean(srsOrderId) || prev.lastSrsOrderId || ''
    };
    /* Houd het overzichtelijk: bewaar maximaal MAX_FAILED meest-recente. */
    const entries = Object.entries(data.failed);
    if (entries.length > MAX_FAILED) {
      entries.sort((a, b) => String(b[1]?.lastAttemptedAt || '').localeCompare(String(a[1]?.lastAttemptedAt || '')));
      data.failed = Object.fromEntries(entries.slice(0, MAX_FAILED));
    }
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { failed: {}, runCount: 0 } });
}

/** Wis een failure (bij succesvolle re-push). */
export async function clearBolSrsFailure(bolOrderId) {
  const id = clean(bolOrderId);
  if (!id) return;
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { failed: { ...(cur.failed || {}) }, runCount: Number(cur.runCount) || 0 }
      : { failed: {}, runCount: 0 };
    delete data.failed[id];
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { failed: {}, runCount: 0 } });
}

/** Bump run-counter (na elke cron-run; voor mail-dedupe basis). */
export async function bumpBolSrsFailuresRunCount() {
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { failed: { ...(cur.failed || {}) }, runCount: (Number(cur.runCount) || 0) + 1 }
      : { failed: {}, runCount: 1 };
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { failed: {}, runCount: 0 } });
}
