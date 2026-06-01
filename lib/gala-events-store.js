/**
 * lib/gala-events-store.js
 *
 * Evenementen-/gala-kalender (studentenverenigingen e.d.) voor marketing/sales.
 * Blob marketing/gala-events.json: { events: [{ id, title, association, city,
 * date, type, source, status, notes, createdAt }] }.
 *
 * status: 'bevestigd' | 'vermoedelijk' | 'gated' (info zit achter login/socials).
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/gala-events.json';
const clean = (v) => String(v == null ? '' : v).trim();
const STATUSES = ['bevestigd', 'vermoedelijk', 'gated'];
const genId = () => 'gala_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function normalize(input) {
  const ev = {
    id: clean(input.id) || genId(),
    title: clean(input.title),
    association: clean(input.association),
    city: clean(input.city),
    date: clean(input.date).slice(0, 10),
    type: clean(input.type) || 'gala',
    source: clean(input.source),
    status: STATUSES.includes(clean(input.status)) ? clean(input.status) : 'vermoedelijk',
    notes: clean(input.notes)
  };
  if (!ev.title || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return null;
  return ev;
}

export async function listEvents() {
  const d = await readJsonBlob(PATH, { events: [] });
  const events = Array.isArray(d && d.events) ? d.events : [];
  return events.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

export async function upsertEvent(input) {
  const ev = normalize(input);
  if (!ev) throw new Error('Titel en geldige datum (YYYY-MM-DD) zijn verplicht.');
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.events)) ? d0 : { events: [] };
    const now = new Date().toISOString();
    const idx = d.events.findIndex((e) => e.id === ev.id);
    if (idx >= 0) d.events[idx] = { ...d.events[idx], ...ev, updatedAt: now };
    else d.events.push({ ...ev, createdAt: now });
    return d;
  }, { fallback: { events: [] } });
  return ev;
}

export async function deleteEvent(id) {
  const key = clean(id);
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.events)) ? d0 : { events: [] };
    d.events = d.events.filter((e) => e.id !== key);
    return d;
  }, { fallback: { events: [] } });
  return true;
}

/** Bulk-seed (research-import) — dedupe op vereniging+datum, voegt alleen nieuwe toe. */
export async function seedEvents(list) {
  const items = (list || []).map(normalize).filter(Boolean);
  if (!items.length) return { added: 0 };
  let added = 0;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.events)) ? d0 : { events: [] };
    const seen = new Set(d.events.map((e) => (e.association || e.title).toLowerCase() + '|' + e.date));
    const now = new Date().toISOString();
    for (const ev of items) {
      const k = (ev.association || ev.title).toLowerCase() + '|' + ev.date;
      if (seen.has(k)) continue;
      seen.add(k);
      d.events.push({ ...ev, createdAt: now, seeded: true });
      added += 1;
    }
    return d;
  }, { fallback: { events: [] } });
  return { added };
}
