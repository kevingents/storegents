import { list, put } from '@vercel/blob';

const PATH = 'srs/dragers-open-cache.json';
const DEFAULT_DEADLINE_HOURS = 48;

function clean(value) {
  return String(value ?? '').trim();
}

function firstFilled(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && clean(value) !== '') return value;
  }
  return '';
}

function stripStore(value) {
  return clean(value).replace(/^\d+\s*-\s*/i, '').trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function dateValue(row = {}) {
  return firstFilled(row.createdAt, row.created_at, row.dateTime, row.datum, row.aangemaaktOp, row.created, row.updatedAt);
}

function ageHours(value) {
  const d = new Date(value || 0);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - d.getTime()) / 36e5));
}

function dragerKey(row = {}) {
  return clean(firstFilled(row.dragerId, row.drager_id, row.id, row.nummer, row.dragerNummer, row.barcode, row.code));
}

export function normalizeDrager(row = {}) {
  const createdAt = clean(dateValue(row));
  const store = stripStore(firstFilled(row.store, row.winkel, row.filiaal, row.filiaalNaam, row.branchName, row.location, row.currentStore));
  const status = clean(firstFilled(row.status, row.state, row.statusLabel, row.srsStatus));
  const items = Array.isArray(row.items) ? row.items : Array.isArray(row.regels) ? row.regels : Array.isArray(row.lines) ? row.lines : [];
  const key = dragerKey(row);
  const h = ageHours(createdAt);
  return {
    ...row,
    id: key,
    dragerId: key,
    store,
    status,
    createdAt,
    ageHours: h,
    overdue: h >= Number(process.env.DRAGER_DEADLINE_HOURS || DEFAULT_DEADLINE_HOURS),
    itemCount: Number(firstFilled(row.itemCount, row.aantalArtikelen, row.aantal, items.length, 0) || 0),
    items
  };
}

export function isOpenDrager(row = {}) {
  const status = lower(row.status);
  if (!status) return true;
  if (status.includes('gesloten') || status.includes('afgerond') || status.includes('verwerkt') || status.includes('closed') || status.includes('done') || status.includes('cancel')) return false;
  return true;
}

async function readText(url) {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error('Drager cache kon niet worden gelezen.');
  return response.text();
}

export async function getDragerCache() {
  try {
    const result = await list({ prefix: PATH, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === PATH);
    if (!blob) return [];
    return JSON.parse(await readText(blob.url) || '[]');
  } catch (error) {
    console.error('[dragers cache read]', error);
    return [];
  }
}

export async function saveDragerCache(rows = []) {
  const normalized = rows.map(normalizeDrager).filter(isOpenDrager);
  await put(PATH, JSON.stringify(normalized, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
  return normalized;
}

export function summarizeDragers(rows = [], store = '') {
  const target = clean(store).toLowerCase();
  const filtered = rows.map(normalizeDrager).filter(isOpenDrager).filter((row) => !target || lower(row.store) === target);
  const overdue = filtered.filter((row) => row.overdue);
  return {
    store,
    openCount: filtered.length,
    overdueCount: overdue.length,
    oldestAgeHours: Math.max(0, ...filtered.map((row) => Number(row.ageHours || 0))),
    rows: filtered,
    overdueRows: overdue
  };
}

export function summarizeDragersByStore(rows = []) {
  const map = new Map();
  rows.map(normalizeDrager).filter(isOpenDrager).forEach((row) => {
    const store = row.store || 'Onbekend';
    if (!map.has(store)) map.set(store, { store, openCount: 0, overdueCount: 0, oldestAgeHours: 0, rows: [] });
    const item = map.get(store);
    item.openCount += 1;
    if (row.overdue) item.overdueCount += 1;
    item.oldestAgeHours = Math.max(item.oldestAgeHours, Number(row.ageHours || 0));
    item.rows.push(row);
  });
  return Array.from(map.values()).sort((a, b) => b.overdueCount - a.overdueCount || b.openCount - a.openCount || a.store.localeCompare(b.store, 'nl'));
}
