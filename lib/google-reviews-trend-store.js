/**
 * Historische trend van Google Reviews score + aantal per winkel.
 *
 * Doel: trend-grafiek tonen (laatste 12 maanden) — laat zien of een winkel
 * verbetert of achteruit gaat. Wordt ge-vuld door nightly cron-snapshot.
 *
 * Blob layout:
 *   google-reviews/trend/<winkelKey>.json
 *   {
 *     store,
 *     snapshots: [
 *       { yyyymm: '2026-05', date: '2026-05-19', rating: 4.7, reviewCount: 82, deltaRating, deltaCount },
 *       ...
 *     ],
 *     updatedAt
 *   }
 *
 * Hardcap: 36 snapshots (= 3 jaar maandelijks).
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH_PREFIX = 'google-reviews/trend/';
const MAX_SNAPSHOTS = 36;

function storeKey(store) {
  return String(store || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function pathFor(store) {
  const key = storeKey(store);
  if (!key) throw new Error('google-reviews-trend: lege store-key');
  return `${PATH_PREFIX}${key}.json`;
}

function currentYyyymm() {
  return new Date().toISOString().slice(0, 7);
}

export async function getTrendForStore(store) {
  if (!store) return { snapshots: [] };
  return readJsonBlob(pathFor(store), { store, snapshots: [], updatedAt: null });
}

/**
 * Voeg/update snapshot toe voor huidige maand. Idempotent — bij meerdere calls
 * op dezelfde dag wordt de laatste waarde overschreven.
 */
export async function recordSnapshot(store, { rating, reviewCount }) {
  if (!store) return null;
  const yyyymm = currentYyyymm();
  const today = new Date().toISOString().slice(0, 10);
  const trend = await getTrendForStore(store);
  const snapshots = Array.isArray(trend.snapshots) ? trend.snapshots.slice() : [];

  const existingIdx = snapshots.findIndex((s) => s.yyyymm === yyyymm);
  const prevSnap = existingIdx > 0 ? snapshots[existingIdx - 1] : (existingIdx === -1 ? snapshots[snapshots.length - 1] : null);
  const deltaRating = prevSnap ? Number((rating || 0) - Number(prevSnap.rating || 0)) : 0;
  const deltaCount = prevSnap ? Number((reviewCount || 0) - Number(prevSnap.reviewCount || 0)) : 0;

  const snap = {
    yyyymm,
    date: today,
    rating: Number(rating || 0),
    reviewCount: Number(reviewCount || 0),
    deltaRating: Math.round(deltaRating * 100) / 100,
    deltaCount
  };

  if (existingIdx >= 0) {
    snapshots[existingIdx] = snap;
  } else {
    snapshots.push(snap);
  }

  /* Sorteer chronologisch en cap */
  snapshots.sort((a, b) => a.yyyymm.localeCompare(b.yyyymm));
  const capped = snapshots.slice(-MAX_SNAPSHOTS);

  await writeJsonBlob(pathFor(store), {
    store,
    snapshots: capped,
    updatedAt: new Date().toISOString()
  });

  return snap;
}

/**
 * Lees laatste N maanden trend voor een winkel.
 */
export async function readRecentTrend(store, months = 12) {
  const trend = await getTrendForStore(store);
  const all = Array.isArray(trend.snapshots) ? trend.snapshots : [];
  return all.slice(-Math.max(1, Math.min(36, months)));
}
