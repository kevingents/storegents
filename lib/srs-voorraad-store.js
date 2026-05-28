/**
 * lib/srs-voorraad-store.js
 *
 * Blob-backed snapshot van de SRS voorraad-exports (voorraad_*.csv +
 * voorraadlocaties_*.csv). Gevuld door api/cron/srs-voorraad-import.js.
 *
 * Blobs:
 *   srs-voorraad/summary-latest.json     — per-filiaal gezondheid (klein, snel)
 *   srs-voorraad/rows-latest.json        — alle voorraad-rijen (rapport-bouwer + lookup)
 *   srs-voorraad/locaties-latest.json    — alle locatie-rijen + locatie-summary
 *
 * Voorraad-row:    { filiaalNummer, store, sku, voorraad, ideaal, tekort }
 *   tekort = max(0, ideaal - voorraad)  (positief = te weinig op voorraad)
 *
 * Locatie-row:     { filiaalNummer, store, locatie, sku, aantal, lastInventarisation, geblokkeerd }
 *
 * In-memory cache (60s) zodat herhaalde reads binnen 1 request-burst snel zijn.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { getStoreNameByBranchId } from './branch-metrics.js';
import { listBranchesFromConfig } from './business-config.js';

const SUMMARY_PATH  = 'srs-voorraad/summary-latest.json';
const ROWS_PATH     = 'srs-voorraad/rows-latest.json';
const LOCATIES_PATH = 'srs-voorraad/locaties-latest.json';

const CACHE_TTL_MS = 60_000;
const _cache = { summary: null, summaryAt: 0, rows: null, rowsAt: 0, locaties: null, locatiesAt: 0 };

/* ──────────────────────────────────────────────────────────────────────
 * Voorraad (actueel vs ideaal)
 * ────────────────────────────────────────────────────────────────────── */

/**
 * Bereken per-filiaal gezondheids-summary uit voorraad-rijen.
 */
function computeSummary(rows) {
  const byFiliaal = new Map();
  const init = (filiaalNummer, store) => {
    if (!byFiliaal.has(filiaalNummer)) {
      byFiliaal.set(filiaalNummer, {
        filiaalNummer,
        store: store || `Filiaal ${filiaalNummer}`,
        totalSkus: 0,
        totalStock: 0,
        skusWithTarget: 0,
        skusUnderIdeal: 0,   /* tekort */
        skusAtIdeal: 0,
        skusOverIdeal: 0,    /* overstock */
        skusOutOfStock: 0,   /* voorraad 0 maar ideaal > 0 */
        skusNegative: 0,     /* voorraad < 0 — data-integriteit alert */
        negativeUnits: 0,    /* som van |voorraad| waar voorraad < 0 */
        shortageUnits: 0,    /* som van (ideaal - voorraad) waar positief */
        overstockUnits: 0    /* som van (voorraad - ideaal) waar positief en ideaal > 0 */
      });
    }
    return byFiliaal.get(filiaalNummer);
  };

  for (const r of rows) {
    const f = init(r.filiaalNummer, r.store);
    f.totalSkus += 1;
    f.totalStock += r.voorraad;
    /* Negatieve voorraad = signaal: verkocht/verstuurd zonder inboeken.
       Telt los van de ideaal-vergelijking (onafhankelijk van target). */
    if (r.voorraad < 0) {
      f.skusNegative += 1;
      f.negativeUnits += Math.abs(r.voorraad);
    }
    if (r.ideaal > 0) {
      f.skusWithTarget += 1;
      if (r.voorraad < r.ideaal) {
        f.skusUnderIdeal += 1;
        f.shortageUnits += (r.ideaal - r.voorraad);
        if (r.voorraad === 0) f.skusOutOfStock += 1;
      } else if (r.voorraad === r.ideaal) {
        f.skusAtIdeal += 1;
      } else {
        f.skusOverIdeal += 1;
        f.overstockUnits += (r.voorraad - r.ideaal);
      }
    }
  }

  /* Sorteer op negatieve eerst (urgentst), dan op tekort */
  const filialen = Array.from(byFiliaal.values()).sort((a, b) => {
    if (b.skusNegative !== a.skusNegative) return b.skusNegative - a.skusNegative;
    return b.shortageUnits - a.shortageUnits;
  });
  const totals = filialen.reduce((acc, f) => ({
    totalSkus: acc.totalSkus + f.totalSkus,
    totalStock: acc.totalStock + f.totalStock,
    skusUnderIdeal: acc.skusUnderIdeal + f.skusUnderIdeal,
    skusOverIdeal: acc.skusOverIdeal + f.skusOverIdeal,
    skusOutOfStock: acc.skusOutOfStock + f.skusOutOfStock,
    skusNegative: acc.skusNegative + f.skusNegative,
    negativeUnits: acc.negativeUnits + f.negativeUnits,
    shortageUnits: acc.shortageUnits + f.shortageUnits,
    overstockUnits: acc.overstockUnits + f.overstockUnits
  }), { totalSkus: 0, totalStock: 0, skusUnderIdeal: 0, skusOverIdeal: 0, skusOutOfStock: 0, skusNegative: 0, negativeUnits: 0, shortageUnits: 0, overstockUnits: 0 });

  return { filialen, totals };
}

/**
 * Schrijf voorraad-snapshot. Berekent summary + bewaart rows.
 * @param {Array} rows  genormaliseerde voorraad-rows
 * @param {Object} meta { sourceFile, fileFrom, fileTo }
 */
export async function writeVoorraadSnapshot(rows, meta = {}) {
  const summary = computeSummary(rows);
  const generatedAt = new Date().toISOString();
  await writeJsonBlob(SUMMARY_PATH, { ...summary, generatedAt, rowCount: rows.length, ...meta });
  await writeJsonBlob(ROWS_PATH, { rows, generatedAt, rowCount: rows.length, ...meta });
  _cache.summary = null; _cache.rows = null; /* invalidate */
  return { summary, rowCount: rows.length };
}

export async function readVoorraadSummary() {
  if (_cache.summary && (Date.now() - _cache.summaryAt) < CACHE_TTL_MS) return _cache.summary;
  const data = await readJsonBlob(SUMMARY_PATH, { filialen: [], totals: {}, generatedAt: null });
  _cache.summary = data; _cache.summaryAt = Date.now();
  return data;
}

export async function readVoorraadRows() {
  if (_cache.rows && (Date.now() - _cache.rowsAt) < CACHE_TTL_MS) return _cache.rows;
  const data = await readJsonBlob(ROWS_PATH, { rows: [], generatedAt: null });
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  _cache.rows = rows; _cache.rowsAt = Date.now();
  return rows;
}

/* ──────────────────────────────────────────────────────────────────────
 * Voorraadlocaties (bin-locaties)
 * ────────────────────────────────────────────────────────────────────── */

function computeLocatieSummary(rows) {
  const byFiliaal = new Map();
  let geblokkeerdTotal = 0;
  let oldestInventarisation = null;
  for (const r of rows) {
    if (!byFiliaal.has(r.filiaalNummer)) {
      byFiliaal.set(r.filiaalNummer, {
        filiaalNummer: r.filiaalNummer,
        store: r.store || `Filiaal ${r.filiaalNummer}`,
        locaties: 0,
        totalAantal: 0,
        geblokkeerd: 0
      });
    }
    const f = byFiliaal.get(r.filiaalNummer);
    f.locaties += 1;
    f.totalAantal += r.aantal;
    if (r.geblokkeerd) { f.geblokkeerd += 1; geblokkeerdTotal += 1; }
    if (r.lastInventarisation) {
      if (!oldestInventarisation || r.lastInventarisation < oldestInventarisation) {
        oldestInventarisation = r.lastInventarisation;
      }
    }
  }
  return {
    filialen: Array.from(byFiliaal.values()).sort((a, b) => b.locaties - a.locaties),
    geblokkeerdTotal,
    oldestInventarisation
  };
}

export async function writeLocatiesSnapshot(rows, meta = {}) {
  const summary = computeLocatieSummary(rows);
  const generatedAt = new Date().toISOString();
  await writeJsonBlob(LOCATIES_PATH, { rows, summary, generatedAt, rowCount: rows.length, ...meta });
  _cache.locaties = null;
  return { summary, rowCount: rows.length };
}

export async function readLocaties() {
  if (_cache.locaties && (Date.now() - _cache.locatiesAt) < CACHE_TTL_MS) return _cache.locaties;
  const data = await readJsonBlob(LOCATIES_PATH, { rows: [], summary: { filialen: [] }, generatedAt: null });
  _cache.locaties = data; _cache.locatiesAt = Date.now();
  return data;
}

export async function readLocatiesRows() {
  const data = await readLocaties();
  return Array.isArray(data?.rows) ? data.rows : [];
}

/* ──────────────────────────────────────────────────────────────────────
 * Cross-reference: op voorraad in MAGAZIJN maar NIET in WINKEL
 *
 * Gedeelde pure helper — gebruikt door zowel de dashboard-endpoint als de
 * rapport-bouwer-bron, zodat de definitie niet uit elkaar loopt.
 *
 * Een SKU is een kandidaat als:
 *   - hij voorraad>0 heeft bij minstens 1 warehouse-filiaal (kind=warehouse)
 *   - hij bij GEEN enkele retail-winkel (kind=retail) voorraad>0 heeft
 *
 * Per SKU: winkelsMetTarget = aantal retail-winkels met ideaal>0 maar voorraad<=0
 * (= winkel zou het moeten voeren maar staat leeg → echte uitlever-gap).
 *
 * @returns {Array<{ sku, magazijn, magazijnVoorraad, winkelsMetTarget, winkelTargetTotaal }>}
 *          gesorteerd op winkelsMetTarget (actionabel) en dan magazijn-voorraad.
 */
export function computeMagazijnNietWinkel(voorraadRows) {
  const branches = listBranchesFromConfig({ includeInternal: true });
  const warehouseIds = new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
  const retailIds = new Set(branches.filter((b) => b.kind === 'retail').map((b) => String(b.branchId)));

  const retailStockSkus = new Set();   /* sku met voorraad>0 bij minstens 1 winkel */
  const retailTargetBySku = new Map(); /* sku → { winkels, targetTotaal } (ideaal>0 & voorraad<=0) */
  const magBySku = new Map();          /* sku → { voorraad, ideaal, stores:Set } over warehouses */

  for (const r of (voorraadRows || [])) {
    const fil = String(r.filiaalNummer);
    if (retailIds.has(fil)) {
      if (r.voorraad > 0) retailStockSkus.add(r.sku);
      if (r.ideaal > 0 && r.voorraad <= 0) {
        if (!retailTargetBySku.has(r.sku)) retailTargetBySku.set(r.sku, { winkels: 0, targetTotaal: 0 });
        const t = retailTargetBySku.get(r.sku);
        t.winkels += 1;
        t.targetTotaal += r.ideaal;
      }
    } else if (warehouseIds.has(fil)) {
      if (r.voorraad > 0) {
        if (!magBySku.has(r.sku)) magBySku.set(r.sku, { voorraad: 0, ideaal: 0, stores: new Set() });
        const m = magBySku.get(r.sku);
        m.voorraad += r.voorraad;
        m.ideaal += r.ideaal;
        m.stores.add(r.store);
      }
    }
  }

  const rows = [];
  for (const [sku, m] of magBySku.entries()) {
    if (retailStockSkus.has(sku)) continue;
    const t = retailTargetBySku.get(sku) || { winkels: 0, targetTotaal: 0 };
    rows.push({
      sku,
      magazijn: Array.from(m.stores).join(', '),
      magazijnVoorraad: m.voorraad,
      winkelsMetTarget: t.winkels,
      winkelTargetTotaal: t.targetTotaal
    });
  }
  rows.sort((a, b) => {
    if (b.winkelsMetTarget !== a.winkelsMetTarget) return b.winkelsMetTarget - a.winkelsMetTarget;
    return b.magazijnVoorraad - a.magazijnVoorraad;
  });
  return rows;
}
