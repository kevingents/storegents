import { put, list } from '@vercel/blob';

/**
 * Transport-ophaallijst voor winkel-naar-winkel uitwisselingen.
 *
 * Een uitwisseling die op de lijst staat moet door chauffeur/magazijn worden
 * opgehaald bij de verzendende winkel. Gedeeld tussen alle gebruikers.
 *
 * Bestand: transport-pickups/pickups.json (Vercel Blob)
 * Structuur: array van items. `key` = uwSentKey uit de portal (stabiel per
 * uitwisseling), waardoor toevoegen idempotent is.
 *   { key, sku, itemDescription, fromStore, toStore, openDate,
 *     status: 'open'|'picked', addedBy, addedAt, updatedAt }
 */

const PATH = 'transport-pickups/pickups.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Ophaallijst kon niet worden gelezen.');
  return response.text();
}

function clean(value) { return String(value ?? '').trim(); }

export async function getAllPickups() {
  try {
    const result = await list({ prefix: PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('[transport-pickups-store] read error:', error);
    return [];
  }
}

async function saveAll(items) {
  await put(PATH, JSON.stringify(items, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
}

export async function addPickup(input = {}) {
  const key = clean(input.key);
  if (!key) throw new Error('Uitwisseling-key ontbreekt.');
  const items = await getAllPickups();
  const existing = items.find((it) => it.key === key);
  if (existing) return existing; /* idempotent — al op de lijst */

  const now = new Date().toISOString();
  const item = {
    key,
    sku: clean(input.sku),
    itemDescription: clean(input.itemDescription),
    fromStore: clean(input.fromStore),
    toStore: clean(input.toStore),
    openDate: clean(input.openDate),
    status: 'open',
    addedBy: clean(input.addedBy) || 'Admin',
    addedAt: now,
    updatedAt: now
  };
  items.unshift(item);
  await saveAll(items);
  return item;
}

export async function removePickup(key) {
  const wanted = clean(key);
  const items = await getAllPickups();
  const next = items.filter((it) => it.key !== wanted);
  if (next.length === items.length) return false;
  await saveAll(next);
  return true;
}

export async function setPickupStatus(key, status) {
  const wanted = clean(key);
  const nextStatus = clean(status) || 'open';
  const items = await getAllPickups();
  let found = false;
  const updated = items.map((it) => {
    if (it.key !== wanted) return it;
    found = true;
    return { ...it, status: nextStatus, updatedAt: new Date().toISOString() };
  });
  if (!found) return false;
  await saveAll(updated);
  return true;
}
