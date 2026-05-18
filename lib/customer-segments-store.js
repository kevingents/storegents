import { put, list } from '@vercel/blob';

/**
 * Customer segments store — bewaart segment-definities (zoek-filters).
 * Bestand: customer-segments/segments.json
 *
 * Segment shape:
 * {
 *   id, name, description,
 *   filters: { tag?, minTotalSpend?, maxDaysInactive?, hasReturns?, hasOpenBills? },
 *   createdAt, createdBy, updatedAt
 * }
 */

const PATH = 'customer-segments/segments.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Segments kon niet worden gelezen.');
  return response.text();
}

export async function getAllSegments() {
  try {
    const result = await list({ prefix: PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === PATH);
    if (!blob) return [];
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error('Read segments error:', error);
    return [];
  }
}

async function saveAllSegments(list) {
  await put(PATH, JSON.stringify(list, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

function clean(value) { return String(value || '').trim(); }

export async function createSegment(input) {
  const name = clean(input.name);
  if (!name) throw new Error('Segment-naam is verplicht.');
  const list = await getAllSegments();
  const seg = {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `seg-${Date.now()}`,
    name,
    description: clean(input.description),
    filters: input.filters && typeof input.filters === 'object' ? input.filters : {},
    createdAt: new Date().toISOString(),
    createdBy: clean(input.createdBy) || 'Admin',
    updatedAt: new Date().toISOString()
  };
  list.unshift(seg);
  await saveAllSegments(list);
  return seg;
}

export async function deleteSegment(id) {
  const list = await getAllSegments();
  const before = list.length;
  const next = list.filter((s) => s.id !== id);
  if (next.length === before) return false;
  await saveAllSegments(next);
  return true;
}
