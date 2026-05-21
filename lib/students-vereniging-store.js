/**
 * Students vereniging-cache.
 *
 * Doel: snel kunnen aggregeren wat de omzet per studentenvereniging is,
 * zonder bij elke pagina-render alle SRS klanten opnieuw door te scannen.
 *
 * Strategie:
 *   1. Een Blob (students-vereniging/map.json) onthoudt per customerId
 *      welke vereniging en welk type vereniging die klant heeft.
 *   2. Incremental rebuild via getCustomers met pagination — elke call
 *      kan max ~500 klanten verwerken voordat Vercel time-out triggert.
 *   3. De omzet-endpoint gebruikt deze cache + een live getTransactions
 *      call op de gewenste periode om te aggregeren.
 *
 * Blob-shape:
 *   {
 *     updatedAt: ISO,
 *     lastFullRebuildAt: ISO,
 *     totalCustomersScanned: number,
 *     totalWithVereniging: number,
 *     verenigingen: [{ name, type, customerCount }],
 *     customers: {
 *       [customerId]: { name, email, vereniging, verenigingType, lastUpdated }
 *     }
 *   }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_KEY = 'students-vereniging/map.json';

function clean(v) { return String(v || '').trim(); }

export async function readVerenigingMap() {
  return readJsonBlob(STORE_KEY, {
    updatedAt: null,
    lastFullRebuildAt: null,
    totalCustomersScanned: 0,
    totalWithVereniging: 0,
    verenigingen: [],
    customers: {}
  });
}

export async function writeVerenigingMap(data) {
  await writeJsonBlob(STORE_KEY, {
    ...data,
    updatedAt: new Date().toISOString()
  });
  return data;
}

/**
 * Verwerk een batch klanten en update de map. Bestaande entries worden
 * geüpdatet (lastUpdated naar nu) of toegevoegd. Klanten zonder vereniging
 * worden geskipt — die nemen anders onnodig veel ruimte in.
 */
export async function upsertCustomersInMap(customers = []) {
  if (!Array.isArray(customers) || !customers.length) return { added: 0, updated: 0, skipped: 0 };

  const map = await readVerenigingMap();
  const now = new Date().toISOString();
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const c of customers) {
    const cid = clean(c?.customerId);
    const ver = clean(c?.vereniging);
    if (!cid) { skipped++; continue; }
    if (!ver) {
      /* Klant heeft geen vereniging — alleen behouden als ze er ooit eentje hadden
         (om historische data niet te verliezen). Anders skippen. */
      if (!map.customers[cid]) { skipped++; continue; }
      /* Als ze er eerder wel een hadden maar nu niet meer → verwijderen */
      delete map.customers[cid];
      updated++;
      continue;
    }
    const existing = map.customers[cid];
    map.customers[cid] = {
      name: clean(c.name || c.displayName || [c.firstName, c.lastName].filter(Boolean).join(' ')),
      email: clean(c.email),
      vereniging: ver,
      verenigingType: clean(c.verenigingType),
      lastUpdated: now
    };
    if (existing) updated++; else added++;
  }

  /* Hertel verenigingen-stats */
  const verStats = new Map();
  for (const entry of Object.values(map.customers)) {
    const name = entry.vereniging;
    if (!name) continue;
    const k = name.toLowerCase();
    const e = verStats.get(k) || { name, type: entry.verenigingType || '', customerCount: 0 };
    e.customerCount += 1;
    /* Houd niet-lege type-waarde */
    if (!e.type && entry.verenigingType) e.type = entry.verenigingType;
    verStats.set(k, e);
  }
  map.verenigingen = Array.from(verStats.values()).sort((a, b) => b.customerCount - a.customerCount);
  map.totalWithVereniging = Object.keys(map.customers).length;

  await writeVerenigingMap(map);
  return { added, updated, skipped, totalWithVereniging: map.totalWithVereniging };
}

/**
 * Markeer een volledige rebuild als afgerond.
 */
export async function markFullRebuild(totalCustomersScanned) {
  const map = await readVerenigingMap();
  map.lastFullRebuildAt = new Date().toISOString();
  map.totalCustomersScanned = Number(totalCustomersScanned || 0);
  await writeVerenigingMap(map);
  return map;
}

/**
 * Lookup helper voor de omzet-endpoint.
 * Returnt undefined als customerId niet in map zit.
 */
export function lookupVerenigingByCustomerId(map, customerId) {
  if (!map?.customers) return undefined;
  return map.customers[clean(customerId)];
}
