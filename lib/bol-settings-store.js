/**
 * lib/bol-settings-store.js
 *
 * Beheer-instellingen voor de bol-marketplace, ingesteld via het centrale
 * Instellingen-menu (niet via env). Precedentie: opgeslagen UI-waarde >
 * env-var > ingebouwde default. Zo blijven env-vars werken als fallback maar
 * kan alles ook in de portal worden gezet.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'marketplace/bol-settings.json';

const envNum = (k, d) => { const v = process.env[k]; return (v != null && v !== '') && Number.isFinite(Number(v)) ? Number(v) : d; };
const envBool = (k, d) => { const v = process.env[k]; if (v == null || v === '') return d; return ['1', 'true', 'yes'].includes(String(v).toLowerCase()); };
const clamp = (n, min, max) => Math.min(max, Math.max(min, n));

/** Lees de effectieve instellingen (opgeslagen waarden over env-defaults). */
export async function getBolSettings() {
  const s = (await readJsonBlob(PATH, null)) || {};
  return {
    /* Voorraad: houd deze marge stuks achter (geen bol-annuleringen). */
    stockBuffer: Number.isFinite(s.stockBuffer) ? s.stockBuffer : envNum('BOL_STOCK_BUFFER', 3),
    /* Prijs: verzendkosten bovenop de webshop-prijs (pariteit). */
    shippingSurcharge: Number.isFinite(s.shippingSurcharge) ? s.shippingSurcharge : envNum('BOL_SHIPPING_SURCHARGE', 0),
    /* Pariteit-speling (€) voor "gelijk". */
    parityTolerance: Number.isFinite(s.parityTolerance) ? s.parityTolerance : envNum('BOL_PARITY_TOLERANCE', 0.02),
    /* Autonomie-schakelaars. */
    stockAuto: typeof s.stockAuto === 'boolean' ? s.stockAuto : envBool('BOL_STOCK_AUTO', true),
    priceAuto: typeof s.priceAuto === 'boolean' ? s.priceAuto : envBool('BOL_PRICE_AUTO', false),
    familiesAuto: typeof s.familiesAuto === 'boolean' ? s.familiesAuto : envBool('BOL_FAMILIES_AUTO', false),
    contentAuto: typeof s.contentAuto === 'boolean' ? s.contentAuto : envBool('BOL_AUTO_CONTENT', false),
    updatedAt: s.updatedAt || null
  };
}

/** Sla (deel van) de instellingen op. Valideert + begrenst de waarden. */
export async function saveBolSettings(patch = {}) {
  const cur = (await readJsonBlob(PATH, null)) || {};
  const next = { ...cur };
  const setNum = (k, min, max) => {
    if (patch[k] != null && patch[k] !== '') { const n = Number(patch[k]); if (Number.isFinite(n)) next[k] = clamp(n, min, max); }
  };
  setNum('stockBuffer', 0, 1000);
  setNum('shippingSurcharge', 0, 100);
  setNum('parityTolerance', 0, 10);
  for (const k of ['stockAuto', 'priceAuto', 'familiesAuto', 'contentAuto']) {
    if (typeof patch[k] === 'boolean') next[k] = patch[k];
  }
  next.updatedAt = new Date().toISOString();
  await writeJsonBlob(PATH, next);
  return getBolSettings();
}
