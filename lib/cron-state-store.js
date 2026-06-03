import { list, put } from '@vercel/blob';

const CRON_STATE_KEY = 'order-cancellations/srs-cancellations-cron-state.json';

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function defaultState() {
  return {
    updatedAt: new Date().toISOString(),
    nextIndex: 0,
    runs: []
  };
}

async function readBlobJson({ strict = false } = {}) {
  /* strict:true → throw bij blob-fout i.p.v. defaultState() retourneren.
     Verplicht voor write-paden (saveCronState/appendCronRun) want anders
     wist één transient leesfout `nextIndex` (rotatie-state) + alle eerdere
     `runs`. Cron herstart from-scratch en kan annuleringen opnieuw verwerken. */
  try {
    const result = await list({ prefix: CRON_STATE_KEY, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === CRON_STATE_KEY) || result.blobs?.[0];
    if (!blob?.url) return defaultState(); /* eerste run = OK */

    const response = await fetch(blob.url, { cache: 'no-store' });
    if (!response.ok) {
      if (strict) throw new Error(`cron-state blob-read mislukt: HTTP ${response.status}`);
      return defaultState();
    }
    const text = await response.text();
    const parsed = safeJson(text, null);
    if (parsed == null) {
      if (strict) throw new Error('cron-state blob JSON-parse mislukt');
      return defaultState();
    }
    return parsed;
  } catch (error) {
    if (strict) throw error;
    console.error('[cron-state-store] read fout (fail-soft):', error.message);
    return defaultState();
  }
}

async function writeBlobJson(data) {
  await put(CRON_STATE_KEY, JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true
  });
}

export async function getCronState() {
  const state = await readBlobJson();
  return {
    ...defaultState(),
    ...state,
    nextIndex: Number.isFinite(Number(state.nextIndex)) ? Number(state.nextIndex) : 0,
    runs: Array.isArray(state.runs) ? state.runs : []
  };
}

async function getCronStateStrict() {
  const state = await readBlobJson({ strict: true });
  return {
    ...defaultState(),
    ...state,
    nextIndex: Number.isFinite(Number(state.nextIndex)) ? Number(state.nextIndex) : 0,
    runs: Array.isArray(state.runs) ? state.runs : []
  };
}

export async function saveCronState(patch = {}) {
  const current = await getCronStateStrict(); /* throw i.p.v. nextIndex/runs wipe */
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
    runs: Array.isArray(patch.runs) ? patch.runs.slice(0, 100) : current.runs.slice(0, 100)
  };
  await writeBlobJson(next);
  return next;
}

export async function appendCronRun(run) {
  const current = await getCronStateStrict();
  const runs = [{ ...run, createdAt: new Date().toISOString() }, ...(current.runs || [])].slice(0, 100);
  return saveCronState({ ...current, runs });
}
