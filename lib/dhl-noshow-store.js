import { put, list } from '@vercel/blob';

/**
 * DHL no-show meldingen: winkel meldt dat DHL vandaag niet is langsgekomen
 * voor pickup. Wordt gebruikt voor:
 *  - automatische mail naar depot
 *  - admin-overzicht hoe vaak per winkel dit gebeurt
 *  - DHL Prestaties pagina
 *
 * Schema per melding:
 *   {
 *     id, store, employeeName, reportedAt, dateMissed (YYYY-MM-DD),
 *     reason?, pickupCount?, depotResponse?, mailStatus
 *   }
 */

const STORE_PATH = 'transport/dhl-noshow.json';

async function readBlobText(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('DHL no-show log kon niet worden gelezen.');
  return r.text();
}

async function loadAll() {
  try {
    const result = await list({ prefix: STORE_PATH, limit: 1 });
    const blob = (result.blobs || []).find((b) => b.pathname === STORE_PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    const arr = JSON.parse(raw || '[]');
    return Array.isArray(arr) ? arr : [];
  } catch (error) {
    console.error('[dhl-noshow-store] read error:', error);
    return [];
  }
}

async function saveAll(rows) {
  await put(STORE_PATH, JSON.stringify(rows.slice(0, 5000), null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
}

export async function addDhlNoshow(input = {}) {
  const all = await loadAll();
  const today = new Date().toISOString().slice(0, 10);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    store: String(input.store || '').trim(),
    employeeName: String(input.employeeName || '').trim(),
    reportedAt: new Date().toISOString(),
    dateMissed: String(input.dateMissed || today).trim(),
    reason: String(input.reason || '').trim().slice(0, 500),
    pickupCount: Number(input.pickupCount || 0),
    depotResponse: '',
    mailStatus: 'pending'
  };
  all.unshift(entry);
  await saveAll(all);
  return entry;
}

export async function updateDhlNoshow(id, patch = {}) {
  const all = await loadAll();
  const idx = all.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch, updatedAt: new Date().toISOString() };
  await saveAll(all);
  return all[idx];
}

export async function getDhlNoshows({ store = '', sinceDays = 90 } = {}) {
  const all = await loadAll();
  const cutoff = Date.now() - sinceDays * 24 * 36e5;
  let rows = all.filter((r) => new Date(r.reportedAt || r.dateMissed || 0).getTime() >= cutoff);
  if (store) {
    const target = String(store).trim().toLowerCase();
    rows = rows.filter((r) => String(r.store || '').trim().toLowerCase() === target);
  }
  return rows;
}

export async function getDhlNoshowStats({ sinceDays = 90 } = {}) {
  const rows = await getDhlNoshows({ sinceDays });
  const byStore = new Map();
  for (const r of rows) {
    const k = r.store || '(onbekend)';
    if (!byStore.has(k)) byStore.set(k, { store: k, count: 0, lastAt: '' });
    const slot = byStore.get(k);
    slot.count += 1;
    if (!slot.lastAt || r.reportedAt > slot.lastAt) slot.lastAt = r.reportedAt;
  }
  return {
    total: rows.length,
    sinceDays,
    perStore: Array.from(byStore.values()).sort((a, b) => b.count - a.count),
    recent: rows.slice(0, 50)
  };
}
