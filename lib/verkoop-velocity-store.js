/**
 * lib/verkoop-velocity-store.js
 *
 * Per-artikel verkoopsnelheid (sku × winkel) over het laatste import-venster
 * (~14 dagen). Opgebouwd in de dagelijkse SRS-retail-import — de ruwe verkoop-
 * regels worden daar tóch al doorlopen (kostprijs + advies), dus dit kost vrijwel
 * niets extra. Geeft de Merchandiser een écht vraag-signaal per winkel:
 *   "winkel A verkoopt dit niet (0 in 14d), winkel B wel (6) → verplaats."
 *
 * Blob srs/verkoop-velocity.json:
 *   { bySkuStore: { '<sku>|<fil>': units }, bySku: { '<sku>': units },
 *     windowDays, from, to, generatedAt }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'srs/verkoop-velocity.json';
const EMPTY = { bySkuStore: {}, bySku: {}, windowDays: null, from: null, to: null, generatedAt: null };

let _cache = null, _at = 0;
const TTL = 60 * 1000;

export async function readVelocity() {
  if (_cache && (Date.now() - _at) < TTL) return _cache;
  const d = await readJsonBlob(PATH, EMPTY);
  _cache = (d && typeof d === 'object' && d.bySkuStore) ? d : { ...EMPTY };
  _at = Date.now();
  return _cache;
}

export async function writeVelocity({ bySkuStore = {}, bySku = {}, windowDays = null, from = null, to = null } = {}) {
  _cache = null;
  return writeJsonBlob(PATH, { bySkuStore, bySku, windowDays, from, to, generatedAt: new Date().toISOString() });
}

/** Verkochte stuks van een sku in een winkel over het venster. */
export function soldFor(vel, sku, fil) {
  return (vel && vel.bySkuStore && vel.bySkuStore[`${sku}|${fil}`]) || 0;
}
/** Verkochte stuks van een sku in de hele keten over het venster. */
export function soldTotal(vel, sku) {
  return (vel && vel.bySku && vel.bySku[sku]) || 0;
}
