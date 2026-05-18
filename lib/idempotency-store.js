/**
 * Idempotency-store voor schadelijke acties (refunds, voucher-acties etc.).
 *
 * Vercel is serverless, dus we hebben twee lagen:
 *   1. In-memory Map (per warm container) — vangt 99% van dubbel-klik gevallen
 *      binnen 15 minuten op zonder Blob-roundtrip.
 *   2. Blob fallback (`idempotency/<scope>/<key>.json`) — vangt herstart van
 *      container OF dubbel-klik over meerdere containers heen op.
 *
 * Werking:
 *   const result = await runOnce('refund', key, async () => { … });
 *   - eerste call: voert het werk uit, slaat response op
 *   - tweede call met zelfde key: geeft cached response terug (response REPLAY)
 *
 * Belangrijk: opslaan gebeurt PAS na succesvol werk, dus mislukte transacties
 * blokkeren geen retry. Daarvoor is de pending-marker: tijdens werk staat key
 * op 'pending' en geeft tweede call een 409 'in-progress' fout terug.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const MEMORY_TTL_MS = Math.max(60_000, Number(process.env.IDEMPOTENCY_MEMORY_TTL_MS || 15 * 60_000));
const BLOB_TTL_MS   = Math.max(MEMORY_TTL_MS, Number(process.env.IDEMPOTENCY_BLOB_TTL_MS || 24 * 60 * 60_000));

/** @type {Map<string, { status: 'pending' | 'done', startedAt: number, finishedAt?: number, response?: any, error?: string }>} */
const memory = new Map();

function blobPath(scope, key) {
  const cleanScope = String(scope || 'default').replace(/[^A-Za-z0-9_-]/g, '_');
  const cleanKey = String(key || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 128);
  if (!cleanKey) throw new Error('idempotency: lege key.');
  return `idempotency/${cleanScope}/${cleanKey}.json`;
}

function memoryKey(scope, key) {
  return `${scope}:::${key}`;
}

function isFresh(entry, ttlMs) {
  if (!entry) return false;
  const ts = entry.finishedAt || entry.startedAt || 0;
  return Date.now() - ts < ttlMs;
}

async function readBlobEntry(scope, key) {
  try {
    return await readJsonBlob(blobPath(scope, key), null);
  } catch (_error) {
    return null;
  }
}

async function writeBlobEntry(scope, key, entry) {
  try {
    await writeJsonBlob(blobPath(scope, key), entry);
  } catch (error) {
    /* Blob falen mag niet de echte actie blokkeren — log + ga door. */
    console.error('[idempotency] blob write fail:', error.message);
  }
}

/**
 * Voer fn() exact één keer uit voor (scope, key). Bij hergebruik replay.
 *
 * @template T
 * @param {string} scope     - bv 'refund', 'voucher-create', etc.
 * @param {string} key       - client-gegenereerde UUID
 * @param {() => Promise<T>} fn  - de actie die maar 1× mag draaien
 * @returns {Promise<{ replayed: boolean, response: T }>}
 */
export async function runOnce(scope, key, fn) {
  if (!key || typeof key !== 'string' || key.length < 8) {
    /* Geen key meegegeven → gewoon uitvoeren zonder idempotency. */
    const response = await fn();
    return { replayed: false, response };
  }

  const mKey = memoryKey(scope, key);

  /* 1. Check in-memory */
  let entry = memory.get(mKey);

  /* 2. Niet in memory → check Blob */
  if (!entry || !isFresh(entry, MEMORY_TTL_MS)) {
    const blobEntry = await readBlobEntry(scope, key);
    if (blobEntry && isFresh(blobEntry, BLOB_TTL_MS)) {
      entry = blobEntry;
      memory.set(mKey, entry);
    }
  }

  if (entry) {
    if (entry.status === 'done') {
      return { replayed: true, response: entry.response };
    }
    if (entry.status === 'pending') {
      const ageMs = Date.now() - (entry.startedAt || 0);
      /* Als pending > 60s, beschouw als dood en sta toe nieuw te starten. */
      if (ageMs < 60_000) {
        const error = new Error('Dezelfde actie is al in behandeling. Wacht tot deze klaar is voordat je opnieuw probeert.');
        error.code = 'IDEMPOTENCY_PENDING';
        error.status = 409;
        throw error;
      }
    }
  }

  /* Markeer pending */
  const pending = { status: 'pending', startedAt: Date.now() };
  memory.set(mKey, pending);

  try {
    const response = await fn();
    const finished = {
      status: 'done',
      startedAt: pending.startedAt,
      finishedAt: Date.now(),
      response
    };
    memory.set(mKey, finished);
    /* Persist async; falen niet blocken */
    writeBlobEntry(scope, key, finished).catch(() => {});
    return { replayed: false, response };
  } catch (error) {
    /* Fouten worden NIET gecached — caller mag opnieuw proberen */
    memory.delete(mKey);
    throw error;
  }
}

/**
 * Light-weight peek/mark API voor endpoints die hun eigen response structureren
 * en daarom liever NIET runOnce gebruiken.
 *
 *   const cached = await peekIdempotency('refund', key);
 *   if (cached) return res.status(cached.status).json({ ...cached.body, replayed: true });
 *   // ... doe werk ...
 *   await markIdempotencyDone('refund', key, 200, finalJson);
 *   return res.status(200).json(finalJson);
 */
export async function peekIdempotency(scope, key) {
  if (!key) return null;
  const mKey = memoryKey(scope, key);
  let entry = memory.get(mKey);
  if (!entry || !isFresh(entry, MEMORY_TTL_MS)) {
    const blobEntry = await readBlobEntry(scope, key);
    if (blobEntry && isFresh(blobEntry, BLOB_TTL_MS)) {
      entry = blobEntry;
      memory.set(mKey, entry);
    }
  }
  if (entry && entry.status === 'done') {
    return { status: entry.httpStatus || 200, body: entry.response };
  }
  return null;
}

export async function markIdempotencyDone(scope, key, httpStatus, response) {
  if (!key) return;
  const mKey = memoryKey(scope, key);
  const entry = {
    status: 'done',
    httpStatus,
    startedAt: Date.now(),
    finishedAt: Date.now(),
    response
  };
  memory.set(mKey, entry);
  writeBlobEntry(scope, key, entry).catch(() => {});
}

/**
 * Maak een prefix wegruimer (bv. handig in tests / debug).
 */
export function clearIdempotencyMemory() {
  memory.clear();
}

/**
 * Stats voor debug / health-check.
 */
export function getIdempotencyStats() {
  const entries = Array.from(memory.entries()).map(([key, entry]) => ({
    key,
    status: entry.status,
    ageMs: Date.now() - (entry.startedAt || 0)
  }));
  return { total: entries.length, entries };
}
