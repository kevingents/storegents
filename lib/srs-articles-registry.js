/**
 * SRS articles registry — houdt bij wanneer een artikel voor het eerst in
 * onze SRS-snapshots verschijnt. Wordt gebruikt voor "Nieuwe artikelen"
 * (new arrivals) op de Voorraad opzoeken-pagina.
 *
 * Strategie:
 *   - Bootstrap-run (de allereerste keer): alle huidige artikelen krijgen
 *     firstSeenAt=null. We weten hun echte creatie-datum in SRS niet, dus
 *     markeren we ze als "pre-existing" en sluiten ze uit van new-arrivals.
 *   - Volgende runs: nieuw gevonden articleKeys krijgen firstSeenAt=now.
 *     Dat is dan een betrouwbare "nieuw aangemaakt" indicator.
 *   - Bestaande entries: lastSeenAt wordt geüpdatet + metadata aangevuld
 *     als de oorspronkelijke leeg was.
 *
 * Blob-layout:
 *   srs-articles-registry/registry.json
 *     {
 *       bootstrappedAt: ISO,
 *       updatedAt: ISO,
 *       articles: {
 *         [key]: { firstSeenAt, lastSeenAt, barcode, sku, articleNumber,
 *                  title, color, size }
 *       }
 *     }
 *
 * key = lowercase(barcode || sku) — uniek per fysieke variant.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const REGISTRY_PATH = 'srs-articles-registry/registry.json';

function clean(v) { return String(v || '').trim(); }

export function articleKey(row = {}) {
  return clean(row.barcode || row.sku || '').toLowerCase();
}

export async function readRegistry() {
  return readJsonBlob(REGISTRY_PATH, {
    bootstrappedAt: null,
    updatedAt: null,
    articles: {}
  });
}

export async function writeRegistry(registry) {
  await writeJsonBlob(REGISTRY_PATH, {
    ...registry,
    updatedAt: new Date().toISOString()
  });
  return registry;
}

/**
 * Upsert articles in registry obv huidige snapshot-rows.
 *
 * - Eerste keer (bootstrappedAt == null) → firstSeenAt = null voor alle artikelen
 * - Daarna → nieuw gevonden articleKeys krijgen firstSeenAt = now
 *
 * Returns { added, updated, bootstrap }
 */
export async function upsertArticles(rows = []) {
  if (!Array.isArray(rows) || !rows.length) return { added: 0, updated: 0, bootstrap: false };

  const registry = await readRegistry();
  const now = new Date().toISOString();
  const isFirstRun = !registry.bootstrappedAt;
  let added = 0;
  let updated = 0;

  /* Dedupliceer rows per key — anders tellen we 23 winkels van hetzelfde
     artikel als 23 inserts en wordt registry onnodig groot. */
  const byKey = new Map();
  for (const r of rows) {
    const key = articleKey(r);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, r);
  }

  for (const [key, r] of byKey) {
    const existing = registry.articles[key];
    if (!existing) {
      registry.articles[key] = {
        firstSeenAt: isFirstRun ? null : now,
        lastSeenAt: now,
        barcode: clean(r.barcode),
        sku: clean(r.sku || r.barcode),
        articleNumber: clean(r.articleNumber || ''),
        title: clean(r.title || ''),
        color: clean(r.color || ''),
        size: clean(r.size || '')
      };
      added += 1;
    } else {
      existing.lastSeenAt = now;
      /* Vul lege metadata aan met verse data */
      if (!existing.title && r.title) existing.title = clean(r.title);
      if (!existing.color && r.color) existing.color = clean(r.color);
      if (!existing.size && r.size) existing.size = clean(r.size);
      if (!existing.articleNumber && r.articleNumber) existing.articleNumber = clean(r.articleNumber);
      if (!existing.barcode && r.barcode) existing.barcode = clean(r.barcode);
      if (!existing.sku && r.sku) existing.sku = clean(r.sku);
      updated += 1;
    }
  }

  if (isFirstRun) registry.bootstrappedAt = now;
  await writeRegistry(registry);
  return { added, updated, bootstrap: isFirstRun };
}

/**
 * Get artikelen met firstSeenAt binnen de laatste N dagen.
 * Excludeert bootstrap-entries (firstSeenAt=null).
 */
export async function getNewArrivals({ days = 14, limit = 50 } = {}) {
  const registry = await readRegistry();
  const cutoffMs = Date.now() - Math.max(1, Number(days) || 14) * 24 * 60 * 60 * 1000;
  const newOnes = [];

  for (const [key, art] of Object.entries(registry.articles || {})) {
    if (!art || !art.firstSeenAt) continue; /* bootstrap → skip */
    const dt = new Date(art.firstSeenAt);
    if (isNaN(dt.getTime()) || dt.getTime() < cutoffMs) continue;
    newOnes.push({ key, ...art });
  }

  newOnes.sort((a, b) => String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || '')));
  return newOnes.slice(0, Math.max(1, Math.min(200, Number(limit) || 50)));
}

export async function getRegistryStats() {
  const registry = await readRegistry();
  const totalArticles = Object.keys(registry.articles || {}).length;
  let withFirstSeen = 0;
  let bootstrap = 0;
  for (const a of Object.values(registry.articles || {})) {
    if (a?.firstSeenAt) withFirstSeen += 1;
    else bootstrap += 1;
  }
  return {
    totalArticles,
    bootstrap,
    withFirstSeen,
    bootstrappedAt: registry.bootstrappedAt,
    updatedAt: registry.updatedAt
  };
}
