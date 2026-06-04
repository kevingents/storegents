/**
 * lib/voorraad-basis-config.js
 *
 * Mapping per categorie (Shopify product.productType) voor welke voorraad-basis
 * de stock-reconcile moet gebruiken:
 *
 *   - 'magazijn'  → vergelijk Shopify met SRS-MAGAZIJN-voorraad (filiaal 99/97).
 *                   Klopt voor producten die typisch in magazijn liggen tot
 *                   ze naar webklanten worden doorgezet (pakken, colberts).
 *   - 'totaal'    → vergelijk Shopify met SRS-TOTAAL (alle 24 filialen samen).
 *                   Klopt voor producten die verspreid over winkels liggen
 *                   (schoenen, accessoires, sokken — winkels verkopen óók online).
 *
 * Blob-config patroon (CLAUDE.md regel: config in de tool, niet in env):
 *   admin/voorraad-basis-config.json = {
 *     "defaultBasis": "magazijn",          // wat als productType niet matched
 *     "mapping": {
 *       "<productType-lowercase>": "magazijn" | "totaal",
 *       ...
 *     }
 *   }
 *
 * Defaults hieronder dekken de meest voorkomende GENTS-categorieën; admin kan
 * via Instellingen → Voorraad-basis later overrides toevoegen zonder deploy.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const CONFIG_PATH = 'admin/voorraad-basis-config.json';
const CACHE_TTL_MS = 5 * 60 * 1000;

const DEFAULT_BASIS_PER_TYPE = {
  /* Magazijn-basis: typisch in magazijn voor webshop-doorzet. */
  pak: 'magazijn',
  pakken: 'magazijn',
  colbert: 'magazijn',
  colberts: 'magazijn',
  kostuum: 'magazijn',
  kostuums: 'magazijn',
  smoking: 'magazijn',
  rokkostuum: 'magazijn',
  overhemd: 'magazijn',
  overhemden: 'magazijn',
  pantalon: 'magazijn',
  pantalons: 'magazijn',
  jas: 'magazijn',
  jassen: 'magazijn',
  vesten: 'magazijn',
  vest: 'magazijn',
  gilet: 'magazijn',
  gilets: 'magazijn',
  ceremoniepakken: 'magazijn',

  /* Totaal-basis: verspreid over winkels, ook online verkocht per winkel. */
  schoen: 'totaal',
  schoenen: 'totaal',
  sneaker: 'totaal',
  sneakers: 'totaal',
  laars: 'totaal',
  laarzen: 'totaal',
  riem: 'totaal',
  riemen: 'totaal',
  sok: 'totaal',
  sokken: 'totaal',
  ondermode: 'totaal',
  onderbroek: 'totaal',
  onderbroeken: 'totaal',
  mode: 'totaal',
  accessoires: 'totaal',
  accessoire: 'totaal',
  tas: 'totaal',
  tassen: 'totaal',
  trui: 'totaal',
  truien: 'totaal',
  shirt: 'totaal',
  shirts: 'totaal',
  jeans: 'totaal',
  broek: 'totaal',
  broeken: 'totaal',
  muts: 'totaal',
  mutsen: 'totaal',
  hoed: 'totaal',
  hoeden: 'totaal',
  stropdas: 'totaal',
  stropdassen: 'totaal',
  pochet: 'totaal',
  pochets: 'totaal'
};

let __cache = null;
let __cacheAt = 0;

/** Lees de actieve config (default-mapping + admin-override uit blob). */
export async function getVoorraadBasisConfig({ refresh = false } = {}) {
  const now = Date.now();
  if (!refresh && __cache && (now - __cacheAt) < CACHE_TTL_MS) return __cache;
  const override = await readJsonBlob(CONFIG_PATH, {}).catch(() => ({}));
  const mapping = { ...DEFAULT_BASIS_PER_TYPE, ...(override?.mapping || {}) };
  const defaultBasis = override?.defaultBasis === 'totaal' ? 'totaal' : 'magazijn';
  __cache = { mapping, defaultBasis, hasOverride: Boolean(override && Object.keys(override).length) };
  __cacheAt = now;
  return __cache;
}

/** Bepaal welke basis voor een gegeven Shopify productType. Returnt 'magazijn' | 'totaal'. */
export function basisForProductType(config, productType) {
  if (!productType) return config?.defaultBasis || 'magazijn';
  const pt = String(productType).toLowerCase().trim();
  if (config.mapping[pt]) return config.mapping[pt];
  /* Tolereer enkelvoud/meervoud — try strip 's' or 'en' */
  const sing1 = pt.replace(/s$/, '');
  if (config.mapping[sing1]) return config.mapping[sing1];
  const sing2 = pt.replace(/en$/, '');
  if (config.mapping[sing2]) return config.mapping[sing2];
  return config.defaultBasis;
}

/** Sla admin-override op. Used by Instellingen-UI later. */
export async function saveVoorraadBasisOverride(patch) {
  const safe = {
    defaultBasis: patch?.defaultBasis === 'totaal' ? 'totaal' : 'magazijn',
    mapping: {}
  };
  if (patch?.mapping && typeof patch.mapping === 'object') {
    for (const [k, v] of Object.entries(patch.mapping)) {
      if (v === 'magazijn' || v === 'totaal') {
        safe.mapping[String(k).toLowerCase().trim()] = v;
      }
    }
  }
  await writeJsonBlob(CONFIG_PATH, safe);
  __cache = null; __cacheAt = 0; /* invalidate cache */
  return safe;
}

/** Default-mapping exporteren zodat de Instellingen-UI 'm kan tonen. */
export const DEFAULT_MAPPING = Object.freeze({ ...DEFAULT_BASIS_PER_TYPE });
