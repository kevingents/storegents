/**
 * GENTS — Verzend-, picking- & transactiekosten config
 * ====================================================
 * Bron-van-waarheid voor de "verborgen" kosten die de webshop-marge/POAS drukken
 * en die nu nergens worden afgetrokken. Config in de tool (blob), aanpasbaar via
 * het Instellingen-menu — geen Vercel env. Werkelijke verzendkosten kunnen later
 * via de DHL-API; tot die tijd geldt de instelbare aanname (hybride).
 *
 * Velden:
 *  - verzendkostPerZendingEx : gem. DHL-kost per zending, EXCL. BTW (BTW is
 *      voorbelasting → terugvorderbaar, dus de echte kost is ex). Default 7.68 =
 *      factuur 9716709 (629 zendingen / € 4.830,04 ex over 1 week).
 *  - pickingKostPerOrderEx   : interne handling/arbeid per order (géén factuur-bron,
 *      puur een aanname die je zelf zet).
 *  - klantVerzendtariefIncl  : wat de klant betaalt onder de gratis-drempel (incl. BTW).
 *  - gratisVanafOrderbedrag  : ordergrens (incl. BTW) waarboven verzending gratis is.
 *  - transactieKostPct / VastEx : PSP-kosten (Mollie/iDEAL) — optioneel, default 0 (uit).
 *  - btwPct                  : voor opbrengst incl. → ex.
 *  - bron                    : 'aanname' (config) of 'werkelijk' (DHL-API, toekomst).
 *
 * Blob-shape (config/verzendkosten-config.json): bovenstaande velden + updatedAt.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_KEY = 'config/verzendkosten-config.json';

/** Code-level defaults (afgeleid van DHL-factuur 9716709 + je verzendregels). */
export const DEFAULT_VERZENDKOSTEN_CONFIG = Object.freeze({
  verzendkostPerZendingEx: 7.68,
  pickingKostPerOrderEx: 1.50,
  klantVerzendtariefIncl: 4.95,
  gratisVanafOrderbedrag: 75,
  transactieKostPct: 0,
  transactieKostVastEx: 0,
  btwPct: 21,
  bron: 'aanname'
});

const num = (v, def, min = 0, max = 1e6) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
};

function clampConfig(c = {}) {
  const d = DEFAULT_VERZENDKOSTEN_CONFIG;
  return {
    verzendkostPerZendingEx: num(c.verzendkostPerZendingEx ?? d.verzendkostPerZendingEx, d.verzendkostPerZendingEx, 0, 100),
    pickingKostPerOrderEx: num(c.pickingKostPerOrderEx ?? d.pickingKostPerOrderEx, d.pickingKostPerOrderEx, 0, 100),
    klantVerzendtariefIncl: num(c.klantVerzendtariefIncl ?? d.klantVerzendtariefIncl, d.klantVerzendtariefIncl, 0, 100),
    gratisVanafOrderbedrag: num(c.gratisVanafOrderbedrag ?? d.gratisVanafOrderbedrag, d.gratisVanafOrderbedrag, 0, 100000),
    transactieKostPct: num(c.transactieKostPct ?? d.transactieKostPct, d.transactieKostPct, 0, 100),
    transactieKostVastEx: num(c.transactieKostVastEx ?? d.transactieKostVastEx, d.transactieKostVastEx, 0, 100),
    btwPct: num(c.btwPct ?? d.btwPct, d.btwPct, 0, 100),
    bron: (c.bron === 'werkelijk') ? 'werkelijk' : 'aanname'
  };
}

/** Lees de effectieve config (defaults + blob-override, geclampd). */
export async function getVerzendkostenConfig() {
  let stored = {};
  try {
    stored = (await readJsonBlob(STORE_KEY, {})) || {};
  } catch (error) {
    console.error('[verzendkosten-config-store] read error:', error.message);
    stored = {};
  }
  return { ...clampConfig(stored), updatedAt: stored.updatedAt || null };
}

/** Sla een (gedeeltelijke) update op; ontbrekende velden behouden hun waarde. */
export async function saveVerzendkostenConfig(partial = {}) {
  const current = await getVerzendkostenConfig();
  const next = { ...clampConfig({ ...current, ...partial }), updatedAt: new Date().toISOString() };
  await writeJsonBlob(STORE_KEY, next);
  return next;
}
