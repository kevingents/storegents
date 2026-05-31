/**
 * GENTS — Reservering-aging watermark
 * ===================================
 *
 * De voorraad-export is een dagelijkse momentopname zonder "sinds wanneer".
 * Om te kunnen tonen hoe lang een artikel in een RES-filiaal staat, houden we
 * een watermark bij: eerste-keer-gezien per (RES-branch, sku). Bij elke
 * voorraad-import:
 *   - nieuwe (branch, sku) → firstSeen = vandaag
 *   - bestaande → firstSeen blijft staan
 *   - verdwenen (artikel uit RES-filiaal) → wordt verwijderd (aging reset)
 *
 * Aging = vandaag − firstSeen. Bouwt vanaf de eerste import op.
 *
 * Blob: reports/reservering-aging.json  →  { firstSeen: { "<branch>|<sku>": "YYYY-MM-DD" }, updatedAt }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_KEY = 'reports/reservering-aging.json';

export function resAgingKey(branchId, sku) {
  return `${String(branchId || '').trim()}|${String(sku || '').trim()}`;
}

function nlToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Amsterdam' });
}

export async function readResAging() {
  const d = await readJsonBlob(STORE_KEY, null);
  if (!d || typeof d !== 'object' || !d.firstSeen) return { firstSeen: {}, updatedAt: null };
  return { firstSeen: d.firstSeen || {}, updatedAt: d.updatedAt || null };
}

/**
 * Werk de watermark bij op basis van de huidige RES-keys.
 * @param {string[]} currentKeys - lijst van resAgingKey(branch, sku) die NU in de RES-filialen staan.
 */
export async function updateResAging(currentKeys = [], today = nlToday()) {
  const cur = await readResAging();
  const prev = cur.firstSeen || {};
  const next = {};
  for (const k of currentKeys) {
    if (!k) continue;
    next[k] = prev[k] || today; /* behoud bestaande first-seen, anders vandaag */
  }
  await writeJsonBlob(STORE_KEY, { firstSeen: next, updatedAt: new Date().toISOString() });
  return next;
}

/** Aantal hele dagen tussen firstSeen en vandaag. */
export function daysSince(dateStr, today = nlToday()) {
  if (!dateStr) return 0;
  const a = new Date(`${dateStr}T00:00:00Z`).getTime();
  const b = new Date(`${today}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}
