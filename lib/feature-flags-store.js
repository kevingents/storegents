/**
 * Feature flags store — Blob-opslag voor admin-toggles.
 *
 * Per-feature schema:
 *   {
 *     enabled: boolean,
 *     updatedAt: ISO timestamp,
 *     updatedBy: 'admin'
 *   }
 *
 * Bekende feature keys (uitbreidbaar):
 *   - 'suitconcer'         — B2B verkoop-filiaal Suitconcer (702 + magazijn 704)
 *   - (toekomstig: meer flags voor pilot-features)
 *
 * Defaults: alle features staan UIT tenzij admin ze aanzet.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'config/feature-flags.json';

/* In-memory cache zodat we niet bij elke request de Blob hitten.
   30s TTL — feature-flag wijzigingen mogen ietsje vertraging hebben. */
const CACHE_TTL_MS = 30 * 1000;
let cache = { at: 0, data: null };

async function loadAll() {
  if (cache.data && (Date.now() - cache.at) < CACHE_TTL_MS) return cache.data;
  const data = await readJsonBlob(STORE_PATH, {});
  cache = { at: Date.now(), data: data && typeof data === 'object' ? data : {} };
  return cache.data;
}

async function saveAll(map) {
  await writeJsonBlob(STORE_PATH, map);
  cache = { at: Date.now(), data: map };
}

export async function getAllFeatureFlags() {
  return loadAll();
}

export async function isFeatureEnabled(key) {
  if (!key) return false;
  const flags = await loadAll();
  return Boolean(flags[String(key)]?.enabled);
}

export async function setFeatureFlag(key, enabled, updatedBy = 'admin') {
  const target = String(key || '').trim();
  if (!target) throw new Error('Feature-flag key ontbreekt.');
  const flags = await loadAll();
  flags[target] = {
    enabled: Boolean(enabled),
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || 'admin')
  };
  await saveAll(flags);
  return { key: target, ...flags[target] };
}

export async function bulkSetFeatureFlags(updates, updatedBy = 'admin') {
  if (!updates || typeof updates !== 'object') throw new Error('Geen updates ontvangen.');
  const flags = await loadAll();
  const now = new Date().toISOString();
  const applied = [];
  for (const [key, enabled] of Object.entries(updates)) {
    const target = String(key || '').trim();
    if (!target) continue;
    flags[target] = {
      enabled: Boolean(enabled),
      updatedAt: now,
      updatedBy: String(updatedBy || 'admin')
    };
    applied.push({ key: target, ...flags[target] });
  }
  await saveAll(flags);
  return { applied, count: applied.length };
}
