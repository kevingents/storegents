/**
 * lib/marketing-store.js
 *
 * Blob-backed opslag voor de Marketing-afdeling:
 *   - campaigns[] : campagne-overzicht (kanaal, winkel, budget, periode, status, doel)
 *   - content[]   : content-kalender items (kanaal, datum, status)
 *   - assets[]    : merk-assets & richtlijnen (logo's, brand guide, templates — links)
 *   - agency{}    : extern marketing-bureau (contact, scope, contract)
 *
 * Blob: config/marketing.json
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'config/marketing.json';
const LIST_KINDS = new Set(['campaigns', 'content', 'assets']);

function emptyState() {
  return { campaigns: [], content: [], assets: [], agency: {}, updatedAt: null, updatedBy: null };
}

function genId(prefix = 'm') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

export async function readMarketing() {
  const raw = await readJsonBlob(STORE_PATH, emptyState());
  return {
    ...emptyState(),
    ...raw,
    campaigns: Array.isArray(raw?.campaigns) ? raw.campaigns : [],
    content: Array.isArray(raw?.content) ? raw.content : [],
    assets: Array.isArray(raw?.assets) ? raw.assets : [],
    agency: raw?.agency && typeof raw.agency === 'object' ? raw.agency : {}
  };
}

async function writeMarketing(state, actor = null) {
  const payload = {
    ...emptyState(),
    ...state,
    updatedAt: new Date().toISOString(),
    updatedBy: actor ? { name: actor.name || '', id: actor.id || '' } : (state.updatedBy || null)
  };
  await writeJsonBlob(STORE_PATH, payload);
  return payload;
}

/* ── Generieke list-CRUD (campaigns / content / assets) ──────────────── */

export async function upsertItem(kind, item = {}, actor = null) {
  if (!LIST_KINDS.has(kind)) throw new Error(`Onbekend type: ${kind}`);
  const state = await readMarketing();
  const list = state[kind];
  const id = String(item.id || '').trim();
  if (id) {
    const idx = list.findIndex((x) => x.id === id);
    if (idx === -1) throw new Error('Item niet gevonden.');
    list[idx] = { ...list[idx], ...item, id, updatedAt: new Date().toISOString() };
    const saved = await writeMarketing({ ...state, [kind]: list }, actor);
    return { item: list[idx], state: saved };
  }
  const created = { ...item, id: genId(kind[0]), createdAt: new Date().toISOString() };
  list.unshift(created);
  const saved = await writeMarketing({ ...state, [kind]: list }, actor);
  return { item: created, state: saved };
}

export async function deleteItem(kind, itemId, actor = null) {
  if (!LIST_KINDS.has(kind)) throw new Error(`Onbekend type: ${kind}`);
  const state = await readMarketing();
  const next = state[kind].filter((x) => x.id !== itemId);
  const saved = await writeMarketing({ ...state, [kind]: next }, actor);
  return { state: saved };
}

export async function saveAgency(agency = {}, actor = null) {
  const state = await readMarketing();
  const merged = { ...(state.agency || {}), ...agency, updatedAt: new Date().toISOString() };
  const saved = await writeMarketing({ ...state, agency: merged }, actor);
  return { agency: merged, state: saved };
}
