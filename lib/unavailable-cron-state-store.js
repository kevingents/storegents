import { list, put } from '@vercel/blob';

const CRON_STATE_KEY = 'order-cancellations/srs-unavailable-cron-state.json';

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
    lastRunAt: '',
    lastSuccess: false,
    runs: []
  };
}

async function readBlobJson() {
  const result = await list({ prefix: CRON_STATE_KEY, limit: 1 });
  const blob = (result.blobs || []).find((item) => item.pathname === CRON_STATE_KEY) || result.blobs?.[0];
  if (!blob?.url) return defaultState();

  const response = await fetch(blob.url, { cache: 'no-store' });
  if (!response.ok) return defaultState();
  const text = await response.text();
  return safeJson(text, defaultState());
}

async function writeBlobJson(data) {
  await put(CRON_STATE_KEY, JSON.stringify(data, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true
  });
}

export async function getUnavailableCronState() {
  const state = await readBlobJson();
  return {
    ...defaultState(),
    ...state,
    runs: Array.isArray(state.runs) ? state.runs : []
  };
}

export async function appendUnavailableCronRun(run = {}) {
  const current = await getUnavailableCronState();
  const nextRun = {
    ...run,
    createdAt: new Date().toISOString()
  };
  const next = {
    ...current,
    updatedAt: new Date().toISOString(),
    lastRunAt: nextRun.createdAt,
    lastSuccess: run.success !== false,
    lastTotals: run.totals || null,
    lastMessage: run.message || '',
    runs: [nextRun, ...(current.runs || [])].slice(0, 100)
  };
  await writeBlobJson(next);
  return next;
}
