import { list, put } from '@vercel/blob';

const LOG_PATH = 'mail-automations/gents-mail-log.json';
const MAX_LOG_ROWS = 5000;

async function readText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Maillog kon niet worden gelezen.');
  return response.text();
}

export async function getMailLog() {
  try {
    const result = await list({ prefix: LOG_PATH, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === LOG_PATH);
    if (!blob) return [];
    return JSON.parse(await readText(blob.url) || '[]');
  } catch (error) {
    console.error('[gents mail log read]', error);
    return [];
  }
}

export async function saveMailLog(rows) {
  await put(LOG_PATH, JSON.stringify((rows || []).slice(0, MAX_LOG_ROWS), null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

/**
 * Sanitize een mail-log message: vervang lange HTML-error-pages door een korte
 * samenvatting + truncate algemene errors op een redelijke lengte zodat de
 * blob niet vervuilt met enorme strings (Vercel 404-pages, stack-traces, etc.).
 */
function sanitizeMessage(msg) {
  if (!msg) return msg;
  const str = String(msg);
  /* HTML-pages detecteren — Vercel 404/500 returnt vaak <!doctype html>… */
  if (/^\s*<(!doctype|html|body)/i.test(str)) {
    const titleMatch = str.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : 'HTML response';
    const httpHint = str.match(/\b(40\d|50\d)\b/);
    return `Endpoint gaf HTML terug (${title}${httpHint ? ` · HTTP ${httpHint[1]}` : ''}) — waarschijnlijk endpoint niet gevonden of deploy-fout.`;
  }
  /* Generiek truncate naar 500 chars zodat blob niet explodeert */
  if (str.length > 500) return str.slice(0, 497) + '…';
  return str;
}

export async function appendMailLog(entry) {
  const rows = await getMailLog();
  const cleanEntry = { ...entry };
  if (cleanEntry.message) cleanEntry.message = sanitizeMessage(cleanEntry.message);
  if (cleanEntry.error) cleanEntry.error = sanitizeMessage(cleanEntry.error);
  rows.unshift({
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    ...cleanEntry
  });
  await saveMailLog(rows);
  return rows[0];
}

/**
 * Bulk-delete entries die matchen op filter (statuses / types / max-age).
 * Returnt aantal verwijderde rijen + totaal-overgebleven.
 */
export async function purgeMailLog({ statuses = [], types = [], olderThanDays = null } = {}) {
  const rows = await getMailLog();
  const statusSet = new Set(statuses.map((s) => String(s || '').toLowerCase()));
  const typeSet = new Set(types.map((t) => String(t || '').toLowerCase()));
  const cutoffMs = olderThanDays != null ? Date.now() - Number(olderThanDays) * 86400 * 1000 : null;
  const keep = [];
  let removed = 0;
  for (const row of rows) {
    const rowStatus = String(row.status || '').toLowerCase();
    const rowType = String(row.type || '').toLowerCase();
    const rowMs = new Date(row.createdAt || row.sentAt || 0).getTime();
    const matchesStatus = statusSet.size && statusSet.has(rowStatus);
    const matchesType = typeSet.size && typeSet.has(rowType);
    const matchesAge = cutoffMs != null && Number.isFinite(rowMs) && rowMs < cutoffMs;
    /* Verwijder als minimaal één criterium matcht (en er minimaal één is opgegeven) */
    const shouldRemove = (statusSet.size || typeSet.size || cutoffMs != null) && (
      (statusSet.size === 0 || matchesStatus) &&
      (typeSet.size === 0 || matchesType) &&
      (cutoffMs == null || matchesAge)
    );
    if (shouldRemove) { removed += 1; continue; }
    keep.push(row);
  }
  if (removed > 0) await saveMailLog(keep);
  return { removed, remaining: keep.length };
}

export function wasSentRecently(rows, { type, store, key, withinHours = 24 }) {
  const since = Date.now() - Number(withinHours || 24) * 36e5;
  return (rows || []).some((row) => {
    const rowTime = new Date(row.createdAt || row.sentAt || 0).getTime();
    return rowTime >= since && row.type === type && row.store === store && String(row.key || '') === String(key || '') && row.status === 'sent';
  });
}

export function monthlyStats(rows, fromDate, toDate) {
  const from = fromDate ? new Date(fromDate) : new Date(new Date().getFullYear(), new Date().getMonth(), 1);
  const to = toDate ? new Date(toDate) : new Date();
  const map = new Map();

  for (const row of rows || []) {
    const d = new Date(row.createdAt || row.sentAt || 0);
    if (Number.isNaN(d.getTime()) || d < from || d > to) continue;
    const store = row.store || 'Onbekend';
    if (!map.has(store)) {
      map.set(store, { store, total: 0, weborderOverdue: 0, weborderRegionManager: 0, pickupNew: 0, pickupReminder: 0, errors: 0 });
    }
    const item = map.get(store);
    item.total += 1;
    if (row.status === 'error') item.errors += 1;
    if (row.type === 'weborder_overdue_store') item.weborderOverdue += 1;
    if (row.type === 'weborder_overdue_region_manager') item.weborderRegionManager += 1;
    if (row.type === 'pickup_new_store') item.pickupNew += 1;
    if (row.type === 'pickup_not_ready_reminder') item.pickupReminder += 1;
  }

  return Array.from(map.values()).sort((a, b) => b.total - a.total || a.store.localeCompare(b.store));
}
