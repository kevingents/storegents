/**
 * lib/kpi-alerts-store.js
 *
 * Tracks welke KPI-alerts vandaag al verzonden zijn — throttling van max
 * 1 alert per (kpi, store, day). Blob-backed.
 *
 * Schema in blob `admin/kpi-alerts.json`:
 *   {
 *     entries: [
 *       { date: '2026-05-27', kpi: 'sales_revenue', store: 'GENTS Arnhem', level: 'warn', value: 12345, target: 25000, sentAt: '...' }
 *     ]
 *   }
 *
 * Entries ouder dan 30 dagen worden gepruned bij elke write om de blob klein
 * te houden.
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const BLOB_PATH = 'admin/kpi-alerts.json';
const RETENTION_DAYS = 30;

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function pruneOldEntries(entries) {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - RETENTION_DAYS);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  return entries.filter((e) => String(e.date || '') >= cutoffStr);
}

export async function readAlertHistory() {
  const data = await readJsonBlob(BLOB_PATH, { entries: [] });
  return Array.isArray(data?.entries) ? data.entries : [];
}

/**
 * Returns true als alert voor (kpi, store, level) vandaag al verstuurd is.
 * Voor warn→danger overgang sturen we wel opnieuw — alleen identical levels
 * worden geblokkeerd.
 */
export async function isAlertAlreadySentToday({ kpi, store, level }) {
  const entries = await readAlertHistory();
  const today = todayStr();
  return entries.some((e) =>
    e.date === today &&
    e.kpi === kpi &&
    e.store === (store || '') &&
    e.level === level
  );
}

function toEntry({ kpi, store, level, value, target, label }) {
  return {
    date: todayStr(),
    kpi,
    store: store || '',
    level,
    value: value == null ? null : Number(value),
    target: target == null ? null : Number(target),
    label: label || '',
    sentAt: new Date().toISOString()
  };
}

/**
 * Markeer meerdere alerts in ÉÉN read-modify-write als verstuurd. De cron
 * stuurt alle alerts van een run hierheen i.p.v. recordAlertSent in een loop —
 * dat voorkwam zowel N blob-round-trips als de race waarbij elke schrijfactie
 * de vorige overschreef (lost dedup-entry -> dubbele alert-mail morgen).
 */
export async function recordAlertsSent(items = []) {
  const list = (Array.isArray(items) ? items : [items]).filter(Boolean);
  if (!list.length) return [];
  const result = await mutateJsonBlob(
    BLOB_PATH,
    (data) => {
      const existing = Array.isArray(data?.entries) ? data.entries : [];
      const pruned = pruneOldEntries(existing);
      for (const it of list) pruned.push(toEntry(it));
      return { entries: pruned };
    },
    { fallback: { entries: [] }, cacheMaxAge: 0 }
  );
  return result.entries;
}

/**
 * Markeer een enkele alert als verstuurd (thin wrapper rond recordAlertsSent).
 */
export async function recordAlertSent(alert) {
  return recordAlertsSent([alert]);
}

/**
 * Voor admin-UI: laatste N alerts.
 */
export async function getRecentAlerts(limit = 50) {
  const entries = await readAlertHistory();
  return entries
    .slice()
    .sort((a, b) => String(b.sentAt || b.date).localeCompare(String(a.sentAt || a.date)))
    .slice(0, limit);
}
