/**
 * lib/bol-stock-failures-store.js
 *
 * Houdt bij welke EANs bij de bol-voorraad-sync faalden. Drijft:
 *   1. UI rode badge / counter-tile in voorraad-sync tab
 *   2. Mail-notificatie via cron bij failures of sanity-aborts
 *
 * Blob: marketplace/bol-stock-failures.json
 *   {
 *     failed: {
 *       "8721157430718": {
 *         ean: "8721157430718",
 *         offerId: "abc-123",
 *         titel: "Bretels basis elastiek zwart",
 *         maat: "One",
 *         intendedAmount: 5,
 *         error: "bol PUT /offers/... (429): rate limit",
 *         lastAttemptedAt: "...",
 *         attemptCount: 3
 *       }
 *     },
 *     lastAbortReason: "Magazijnvoorraad is overal 0 — ...",
 *     lastAbortAt: "...",
 *     updatedAt: "...",
 *     runCount: N
 *   }
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'marketplace/bol-stock-failures.json';
const MAX_FAILED = 1000;

const clean = (v) => String(v == null ? '' : v).trim();

export async function readBolStockFailures() {
  const data = await readJsonBlob(PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.failed && typeof data.failed === 'object') return data;
  return { failed: {}, lastAbortReason: null, lastAbortAt: null, updatedAt: null, runCount: 0 };
}

export async function recordBolStockFailure(ean, info = {}) {
  const id = clean(ean);
  if (!id) return;
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { failed: { ...(cur.failed || {}) }, runCount: Number(cur.runCount) || 0,
          lastAbortReason: cur.lastAbortReason || null, lastAbortAt: cur.lastAbortAt || null }
      : { failed: {}, runCount: 0, lastAbortReason: null, lastAbortAt: null };
    const prev = data.failed[id] || {};
    data.failed[id] = {
      ean: id,
      offerId: clean(info.offerId) || prev.offerId || '',
      titel: clean(info.titel) || prev.titel || '',
      maat: clean(info.maat) || prev.maat || '',
      intendedAmount: info.intendedAmount != null ? Number(info.intendedAmount) : prev.intendedAmount,
      error: clean(info.error).slice(0, 1000),
      lastAttemptedAt: new Date().toISOString(),
      attemptCount: (Number(prev.attemptCount) || 0) + 1
    };
    const entries = Object.entries(data.failed);
    if (entries.length > MAX_FAILED) {
      entries.sort((a, b) => String(b[1]?.lastAttemptedAt || '').localeCompare(String(a[1]?.lastAttemptedAt || '')));
      data.failed = Object.fromEntries(entries.slice(0, MAX_FAILED));
    }
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { failed: {}, runCount: 0, lastAbortReason: null, lastAbortAt: null } });
}

export async function clearBolStockFailure(ean) {
  const id = clean(ean);
  if (!id) return;
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { failed: { ...(cur.failed || {}) }, runCount: Number(cur.runCount) || 0,
          lastAbortReason: cur.lastAbortReason || null, lastAbortAt: cur.lastAbortAt || null }
      : { failed: {}, runCount: 0, lastAbortReason: null, lastAbortAt: null };
    delete data.failed[id];
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { failed: {}, runCount: 0, lastAbortReason: null, lastAbortAt: null } });
}

export async function recordBolStockAbort(reason) {
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { failed: { ...(cur.failed || {}) }, runCount: (Number(cur.runCount) || 0) + 1,
          lastAbortReason: clean(reason).slice(0, 500),
          lastAbortAt: new Date().toISOString() }
      : { failed: {}, runCount: 1, lastAbortReason: clean(reason), lastAbortAt: new Date().toISOString() };
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { failed: {}, runCount: 0, lastAbortReason: null, lastAbortAt: null } });
}

export async function clearBolStockAbort() {
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { failed: { ...(cur.failed || {}) }, runCount: Number(cur.runCount) || 0,
          lastAbortReason: null, lastAbortAt: null }
      : { failed: {}, runCount: 0, lastAbortReason: null, lastAbortAt: null };
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { failed: {}, runCount: 0, lastAbortReason: null, lastAbortAt: null } });
}
