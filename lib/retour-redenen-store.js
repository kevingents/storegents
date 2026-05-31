/**
 * GENTS — Winkel-retour-redenen ledger (klacht / retour / ruiling)
 * ===============================================================
 *
 * Per winkel per dag bijgehouden hoeveel retour-regels er waren per reden,
 * opgebouwd uit de SRS verkopen-export (kolom retour_code: 1=klacht, 2=retour,
 * 3=ruiling; leeg = overig). Webshop (weborder-verwerking) wordt uitgesloten —
 * dit zijn pure winkel-retouren.
 *
 * Net als de omzet-ledger: per (filiaal, dag) OVERSCHRIJVEN (newest-wins) zodat
 * overlappende export-vensters niet dubbel tellen. Aggregaten zijn periode-
 * instelbaar; detailregels worden (begrensd) bewaard voor export/drill-down.
 *
 * Blob: reports/retour-redenen.json
 *   { stores: { [fil]: { name, days: { [date]: { klacht:{regels,stuks,eur}, … } } } },
 *     details: [ { date, fil, store, reden, sku, stuks, eur, origBon, bon } ],
 *     updatedAt }
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';
import { getStoreNameByBranchId } from './branch-metrics.js';

const PATH = 'reports/retour-redenen.json';
const MAX_DAYS = 400;       /* aggregaten-historie per winkel */
const MAX_DETAILS = 15000;  /* begrens detailregels (blob-grootte) */

export const RETOUR_REASONS = ['klacht', 'retour', 'ruiling', 'overig'];
export const RETOUR_REASON_LABELS = { klacht: 'Klacht', retour: 'Retour', ruiling: 'Ruiling', overig: 'Overig' };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/** retour_code → reden. 1=klacht, 2=retour, 3=ruiling, anders overig. */
export function retourReason(code) {
  const c = String(code || '').trim();
  if (c === '1') return 'klacht';
  if (c === '2') return 'retour';
  if (c === '3') return 'ruiling';
  return 'overig';
}

function emptyReasons() {
  return {
    klacht: { regels: 0, stuks: 0, eur: 0 },
    retour: { regels: 0, stuks: 0, eur: 0 },
    ruiling: { regels: 0, stuks: 0, eur: 0 },
    overig: { regels: 0, stuks: 0, eur: 0 }
  };
}

export async function readRetourRedenen() {
  const d = await readJsonBlob(PATH, null);
  if (!d || typeof d !== 'object') return { stores: {}, details: [], updatedAt: null };
  return { stores: d.stores || {}, details: Array.isArray(d.details) ? d.details : [], updatedAt: d.updatedAt || null };
}

/**
 * Merge nieuwe dag-aggregaten + detailregels.
 * @param {{ days: Object, details: Array }} newData
 *   days = { [date]: { [fil]: { klacht:{regels,stuks,eur}, … } } }
 */
export async function mergeRetourRedenen(newData = {}) {
  const incoming = newData.days || {};
  const incomingDetails = Array.isArray(newData.details) ? newData.details : [];
  const incomingDates = new Set(Object.keys(incoming));

  return mutateJsonBlob(
    PATH,
    (cur0) => {
      const cur = (cur0 && typeof cur0 === 'object') ? cur0 : {};
      const stores = cur.stores || {};

      /* Overschrijf per (filiaal, dag). */
      for (const [date, fils] of Object.entries(incoming)) {
        for (const [fil, reasons] of Object.entries(fils)) {
          if (!stores[fil]) stores[fil] = { name: getStoreNameByBranchId(fil), days: {} };
          stores[fil].name = getStoreNameByBranchId(fil);
          if (!stores[fil].days) stores[fil].days = {};
          stores[fil].days[date] = reasons;
        }
      }

      /* Retentie: dagen ouder dan MAX_DAYS afkappen. */
      const allDates = new Set();
      for (const s of Object.values(stores)) for (const d of Object.keys(s.days || {})) allDates.add(d);
      const sorted = [...allDates].sort();
      const keepFrom = sorted.length > MAX_DAYS ? sorted[sorted.length - MAX_DAYS] : '';
      if (keepFrom) for (const s of Object.values(stores)) for (const d of Object.keys(s.days || {})) if (d < keepFrom) delete s.days[d];

      /* Details: vervang voor de binnenkomende datums, append, prune. */
      let details = Array.isArray(cur.details) ? cur.details : [];
      details = details.filter((x) => !incomingDates.has(x.date));
      details = details.concat(incomingDetails);
      if (keepFrom) details = details.filter((x) => x.date >= keepFrom);
      details.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)); /* nieuwste eerst */
      if (details.length > MAX_DETAILS) details = details.slice(0, MAX_DETAILS);

      return { stores, details, updatedAt: new Date().toISOString() };
    },
    { fallback: { stores: {}, details: [], updatedAt: null }, cacheMaxAge: 0 }
  );
}

/** Aggregeer per winkel over [from,to] (datums YYYY-MM-DD). */
export function aggregateRetourRedenen(data, { from, to } = {}) {
  const perStore = [];
  const totals = emptyReasons();
  for (const [fil, s] of Object.entries(data.stores || {})) {
    const agg = emptyReasons();
    let hit = false;
    for (const [date, reasons] of Object.entries(s.days || {})) {
      if ((from && date < from) || (to && date > to)) continue;
      for (const reason of RETOUR_REASONS) {
        const v = reasons[reason]; if (!v) continue;
        agg[reason].regels += v.regels || 0; agg[reason].stuks += v.stuks || 0; agg[reason].eur += v.eur || 0;
        totals[reason].regels += v.regels || 0; totals[reason].stuks += v.stuks || 0; totals[reason].eur += v.eur || 0;
        hit = true;
      }
    }
    if (!hit) continue;
    for (const reason of RETOUR_REASONS) agg[reason].eur = round2(agg[reason].eur);
    const totaalRegels = RETOUR_REASONS.reduce((n, r) => n + agg[r].regels, 0);
    const totaalEur = round2(RETOUR_REASONS.reduce((n, r) => n + agg[r].eur, 0));
    perStore.push({ filiaalNummer: fil, store: s.name || getStoreNameByBranchId(fil), ...agg, totaalRegels, totaalEur });
  }
  for (const reason of RETOUR_REASONS) totals[reason].eur = round2(totals[reason].eur);
  perStore.sort((a, b) => b.totaalRegels - a.totaalRegels);
  return {
    perStore,
    totals,
    totaalRegels: RETOUR_REASONS.reduce((n, r) => n + totals[r].regels, 0),
    totaalEur: round2(RETOUR_REASONS.reduce((n, r) => n + totals[r].eur, 0)),
    window: { from, to }
  };
}

/** Detailregels binnen [from,to] (optioneel per winkel). */
export function retourDetailsInRange(data, { from, to, store } = {}) {
  const sf = String(store || '').trim().toLowerCase();
  return (data.details || []).filter((d) =>
    (!from || d.date >= from) && (!to || d.date <= to) && (!sf || String(d.store || '').toLowerCase() === sf)
  );
}
