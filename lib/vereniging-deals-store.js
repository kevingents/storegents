/**
 * Vereniging Deals store — Blob-backed.
 *
 * Deals/acties tussen GENTS en studentenverenigingen.
 *
 * Blob: admin/vereniging-deals.json
 *   {
 *     deals: [{
 *       id: 'deal-{shortid}',
 *       vereniging: 'Minerva Leiden',           // moet matchen met SRS vereniging
 *       title: 'Studentenstart-actie',
 *       description: 'Volledig beschrijving...',
 *       discountText: '20% op alle pakken',
 *       startDate: '2026-05-20',                // ISO date YYYY-MM-DD
 *       endDate: '2026-08-31',
 *       stores: ['GENTS Leiden', 'GENTS Amsterdam'] | 'all',
 *       conditions: 'Geldige collegekaart vereist + min. €100',
 *       cassaInstructions: 'Kassa: typ STUDENT20 in kortingsveld',
 *       active: true,
 *       createdAt, updatedAt, createdBy
 *     }]
 *   }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { randomBytes } from 'node:crypto';

const STORE_PATH = 'admin/vereniging-deals.json';

function clean(v) { return String(v || '').trim(); }
function shortId() { return randomBytes(6).toString('hex'); }
function nowIso() { return new Date().toISOString(); }

export async function readAllDeals() {
  const data = await readJsonBlob(STORE_PATH, { deals: [] });
  return Array.isArray(data.deals) ? data.deals : [];
}

export async function writeAllDeals(deals) {
  await writeJsonBlob(STORE_PATH, {
    deals: Array.isArray(deals) ? deals : [],
    updatedAt: nowIso()
  });
}

export async function getDealById(id) {
  const deals = await readAllDeals();
  return deals.find((d) => d.id === id) || null;
}

/**
 * Maak of update een deal.
 * input: { id?, vereniging, title, ... }
 * createdBy: actor naam/id
 */
export async function upsertDeal(input = {}, createdBy = 'admin') {
  const vereniging = clean(input.vereniging);
  const title = clean(input.title);
  if (!vereniging) throw new Error('vereniging is verplicht.');
  if (!title) throw new Error('title is verplicht.');

  const startDate = clean(input.startDate);
  const endDate = clean(input.endDate);
  if (!startDate || !endDate) throw new Error('startDate en endDate zijn verplicht (YYYY-MM-DD).');
  if (endDate < startDate) throw new Error('endDate moet >= startDate zijn.');

  const stores = (input.stores === 'all' || !input.stores)
    ? 'all'
    : (Array.isArray(input.stores) ? input.stores.map(clean).filter(Boolean) : []);

  const deals = await readAllDeals();
  const id = input.id || `deal-${shortId()}`;
  const existing = deals.find((d) => d.id === id);
  const now = nowIso();
  const updated = {
    id,
    vereniging,
    title,
    description: clean(input.description),
    discountText: clean(input.discountText),
    startDate,
    endDate,
    stores: stores === 'all' ? 'all' : (stores.length ? stores : 'all'),
    conditions: clean(input.conditions),
    cassaInstructions: clean(input.cassaInstructions),
    active: input.active !== false,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || String(createdBy || 'admin'),
    lastUpdatedBy: String(createdBy || 'admin')
  };
  const idx = deals.findIndex((d) => d.id === id);
  if (idx >= 0) deals[idx] = updated;
  else deals.push(updated);
  await writeAllDeals(deals);
  return updated;
}

export async function deleteDeal(id) {
  if (!id) return false;
  const deals = await readAllDeals();
  const idx = deals.findIndex((d) => d.id === id);
  if (idx === -1) return false;
  deals.splice(idx, 1);
  await writeAllDeals(deals);
  return true;
}

/**
 * Lijst alle deals die NU actief zijn voor een specifieke winkel.
 * stores='all' betekent: alle winkels.
 */
export async function getActiveDealsForStore(storeName, { now = new Date() } = {}) {
  const all = await readAllDeals();
  const today = (now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10);
  const store = clean(storeName);
  return all.filter((d) => {
    if (!d.active) return false;
    if (d.startDate > today) return false;
    if (d.endDate < today) return false;
    if (d.stores === 'all') return true;
    if (!Array.isArray(d.stores)) return false;
    return d.stores.some((s) => clean(s).toLowerCase() === store.toLowerCase());
  });
}

/**
 * Lijst alle deals voor een specifieke vereniging.
 */
export async function getDealsForVereniging(verenigingName) {
  const all = await readAllDeals();
  const target = clean(verenigingName).toLowerCase();
  return all.filter((d) => clean(d.vereniging).toLowerCase() === target);
}
