import { list, put } from '@vercel/blob';

const LOG_PATH = 'cron-automations/gents-cron-log.json';
const MAX_LOG_ROWS = 5000;

async function readText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Cronlog kon niet worden gelezen.');
  return response.text();
}

export async function getCronLog() {
  try {
    const result = await list({ prefix: LOG_PATH, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === LOG_PATH);
    if (!blob) return [];
    return JSON.parse((await readText(blob.url)) || '[]');
  } catch (error) {
    console.error('[gents cron log read]', error);
    return [];
  }
}

export async function saveCronLog(rows) {
  await put(LOG_PATH, JSON.stringify((rows || []).slice(0, MAX_LOG_ROWS), null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

export async function appendCronLog(entry = {}) {
  const rows = await getCronLog();
  const row = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    status: entry.status || 'success',
    ...entry
  };
  rows.unshift(row);
  await saveCronLog(rows);
  return row;
}

export async function withCronLog({ job, source = 'cron', meta = {} }, fn) {
  const startedAt = Date.now();
  try {
    const result = await fn();
    await appendCronLog({
      job,
      source,
      status: 'success',
      durationMs: Date.now() - startedAt,
      meta,
      result: summarizeResult(result)
    });
    return result;
  } catch (error) {
    await appendCronLog({
      job,
      source,
      status: 'error',
      durationMs: Date.now() - startedAt,
      meta,
      message: error.message || String(error)
    });
    throw error;
  }
}

export function summarizeResult(result) {
  if (!result || typeof result !== 'object') return result ?? null;
  const summary = {};
  for (const key of ['success', 'dryRun', 'sent', 'skipped', 'synced', 'failed', 'errors', 'warnings', 'dateFrom', 'dateTo']) {
    if (result[key] !== undefined) summary[key] = Array.isArray(result[key]) ? result[key].length : result[key];
  }
  if (Array.isArray(result.results)) summary.results = result.results.length;
  if (Array.isArray(result.rows)) summary.rows = result.rows.length;
  return Object.keys(summary).length ? summary : null;
}

export function cronStats(rows = []) {
  const map = new Map();
  for (const row of rows) {
    const job = row.job || row.type || 'onbekend';
    if (!map.has(job)) map.set(job, { job, total: 0, success: 0, error: 0, lastRunAt: '', lastStatus: '', lastDurationMs: 0, lastMessage: '' });
    const item = map.get(job);
    item.total += 1;
    if (row.status === 'error') item.error += 1;
    else item.success += 1;
    if (!item.lastRunAt || String(row.createdAt || '') > item.lastRunAt) {
      item.lastRunAt = row.createdAt || '';
      item.lastStatus = row.status || '';
      item.lastDurationMs = Number(row.durationMs || 0);
      item.lastMessage = row.message || '';
    }
  }
  return Array.from(map.values()).sort((a, b) => String(b.lastRunAt).localeCompare(String(a.lastRunAt)));
}
