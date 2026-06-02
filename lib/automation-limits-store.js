/**
 * lib/automation-limits-store.js
 *
 * Verzend-rem voor alle automations (config in de tool, niet in Vercel):
 *   - maxPerDay              : harde dag-limiet over álle automations samen
 *   - oncePerCustomerPerDay  : nooit 2 automation-mails op dezelfde dag naar
 *                              dezelfde klant
 *
 * Daarnaast een dagelijkse verzend-teller (ledger) die de runner bijhoudt zodat
 * de rem over meerdere automation-runs/crons heen werkt. De ledger reset
 * automatisch per kalenderdag.
 *
 * Opslag: blob marketing/automation-limits.json + marketing/automation-sent-log.json.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const LIMITS_PATH = 'marketing/automation-limits.json';
const LEDGER_PATH = 'marketing/automation-sent-log.json';

export const AUTOMATION_LIMIT_DEFAULTS = { maxPerDay: 500, oncePerCustomerPerDay: true };

export async function getAutomationLimits() {
  const t = await readJsonBlob(LIMITS_PATH, null).catch(() => null);
  return { ...AUTOMATION_LIMIT_DEFAULTS, ...(t || {}) };
}

export async function saveAutomationLimits(patch = {}) {
  const cur = await getAutomationLimits();
  const next = { ...cur };
  if (patch.maxPerDay != null) {
    const n = Number(patch.maxPerDay);
    next.maxPerDay = Number.isFinite(n) ? Math.max(0, Math.min(100000, Math.round(n))) : cur.maxPerDay;
  }
  if (patch.oncePerCustomerPerDay != null) next.oncePerCustomerPerDay = Boolean(patch.oncePerCustomerPerDay);
  next.updatedAt = new Date().toISOString();
  await writeJsonBlob(LIMITS_PATH, next);
  return next;
}

export function todayKey() { return new Date().toISOString().slice(0, 10); }

/* Ledger van vandaag (reset automatisch bij dagwissel). */
export async function loadSentLedger() {
  const today = todayKey();
  const l = await readJsonBlob(LEDGER_PATH, null).catch(() => null);
  if (!l || l.date !== today) return { date: today, perCustomer: {}, total: 0 };
  return { date: today, perCustomer: l.perCustomer || {}, total: Number(l.total) || 0 };
}

export async function saveSentLedger(ledger) {
  await writeJsonBlob(LEDGER_PATH, {
    date: ledger.date || todayKey(),
    perCustomer: ledger.perCustomer || {},
    total: Number(ledger.total) || 0,
    updatedAt: new Date().toISOString()
  });
}
