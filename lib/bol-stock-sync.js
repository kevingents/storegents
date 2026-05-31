/**
 * lib/bol-stock-sync.js
 *
 * Zet de bol-voorraad gelijk aan de SRS-MAGAZIJNvoorraad. GENTS verkoopt op bol
 * alleen wat direct uit het magazijn leverbaar is (snelheid garanderen), dus:
 *   bol-voorraad = magazijnvoorraad   (0 als niet op magazijn → geen overselling)
 *
 * Flow:
 *   1. magazijnvoorraad per SKU uit de SRS-voorraadsnapshot (kind=warehouse)
 *   2. map SKU → EAN via de Shopify-productcache
 *   3. EAN → bol offerId via de offers-export (gecachte map, los ververst)
 *   4. PUT /retailer/offers/{offerId}/stock  (alleen waar het bedrag wijzigt)
 *
 * Standaard DRY-RUN: toont wat er gezet zou worden zonder naar bol te schrijven.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readVoorraadRows } from './srs-voorraad-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { listBranchesFromConfig } from './business-config.js';
import { bolPost, bolGetCsv, bolWaitForProcess, isBolConfigured } from './bol-client.js';

const PLAN_PATH = 'marketplace/bol-stock-plan.json';
const OFFER_MAP_PATH = 'marketplace/bol-offer-map.json';
const MAX_AGE_MS = Number(process.env.BOL_STOCK_MAX_AGE_MS || 60 * 60 * 1000);
const OFFER_MAP_MAX_AGE_MS = Number(process.env.BOL_OFFER_MAP_MAX_AGE_MS || 24 * 60 * 60 * 1000);
const MAX_PUSH = Number(process.env.BOL_STOCK_MAX_PUSH || 1000);

const clean = (v) => String(v == null ? '' : v).trim();
const skuKey = (v) => clean(v).toLowerCase();
const toStock = (n) => Math.max(0, Math.round(Number(n) || 0));

/* ── Magazijnvoorraad per SKU uit de SRS-snapshot. ─────────────────────── */
function warehouseStockBySku(rows) {
  const branches = listBranchesFromConfig({ includeInternal: true });
  const warehouseIds = new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
  const bySku = new Map();
  for (const r of (rows || [])) {
    if (!warehouseIds.has(String(r.filiaalNummer))) continue;
    const k = skuKey(r.sku);
    if (!k) continue;
    bySku.set(k, (bySku.get(k) || 0) + Number(r.voorraad || 0));
  }
  return { bySku, warehouseConfigured: warehouseIds.size > 0 };
}

/** Bouw per EAN de gewenste bol-voorraad (= magazijnvoorraad). */
export async function buildBolStockPlan() {
  const [rows, cache] = await Promise.all([readVoorraadRows(), readProductsCache()]);
  const { bySku, warehouseConfigured } = warehouseStockBySku(rows);
  const byBarcode = (cache && cache.byBarcode) || {};

  /* Eén regel per EAN; voorraad = magazijn van de bijbehorende SKU (0 default). */
  const seen = new Set();
  const items = [];
  let metVoorraad = 0;
  for (const v of Object.values(byBarcode)) {
    const ean = clean(v.barcode);
    if (!ean || seen.has(ean)) continue;
    seen.add(ean);
    const magazijn = toStock(bySku.get(skuKey(v.sku)));
    if (magazijn > 0) metVoorraad += 1;
    items.push({ ean, sku: clean(v.sku), titel: clean(v.title), kleur: clean(v.color), maat: clean(v.size), magazijnVoorraad: magazijn });
  }
  items.sort((a, b) => b.magazijnVoorraad - a.magazijnVoorraad);

  const offerMap = await readJsonBlob(OFFER_MAP_PATH, null);
  const result = {
    refreshedAt: new Date().toISOString(),
    principe: 'bol-voorraad = magazijnvoorraad (0 als niet op magazijn)',
    warehouseConfigured,
    totaal: items.length,
    metVoorraad,
    zonderVoorraad: items.length - metVoorraad,
    offerMap: offerMap ? { refreshedAt: offerMap.refreshedAt, count: offerMap.count } : null,
    items: items.slice(0, 3000)
  };
  try { await writeJsonBlob(PLAN_PATH, result); } catch (_) {}
  return result;
}

export async function readBolStockPlan() { return readJsonBlob(PLAN_PATH, null); }
export function isStockPlanFresh(p) { return p?.refreshedAt && (Date.now() - new Date(p.refreshedAt).getTime()) < MAX_AGE_MS; }

/* ── CSV-parser (RFC4180-light: quotes + dubbele quotes). ──────────────── */
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  const s = String(text || '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/**
 * Ververs de EAN → {offerId, stock}-map via de bol offers-export. Traag (async
 * proces bij bol), dus los van de stock-push gehouden + gecached.
 */
export async function refreshBolOfferMap({ maxWaitMs = 50000 } = {}) {
  if (!isBolConfigured()) return { ok: false, reason: 'bol niet gekoppeld' };
  const start = await bolPost('/offers/export', { format: 'CSV' });
  const done = await bolWaitForProcess(start?.processStatusId, { maxWaitMs });
  if (clean(done?.status).toUpperCase() !== 'SUCCESS') {
    return { ok: false, pending: true, processStatusId: clean(start?.processStatusId), message: 'Export nog niet klaar — probeer zo opnieuw.' };
  }
  const reportId = clean(done?.entityId);
  const csv = await bolGetCsv(`/offers/export/${reportId}`);
  const rows = parseCsv(csv);
  if (!rows.length) return { ok: false, reason: 'lege export' };
  const head = rows[0].map((h) => clean(h).toLowerCase());
  const iOffer = head.indexOf('offerid');
  const iEan = head.indexOf('ean');
  const iStock = head.findIndex((h) => h === 'stockamount' || h === 'correctedstock');
  if (iOffer < 0 || iEan < 0) return { ok: false, reason: 'export mist offerId/ean kolom' };
  const byEan = {};
  for (let r = 1; r < rows.length; r++) {
    const ean = clean(rows[r][iEan]);
    const offerId = clean(rows[r][iOffer]);
    if (!ean || !offerId) continue;
    byEan[ean] = { offerId, stock: iStock >= 0 ? toStock(rows[r][iStock]) : null };
  }
  const map = { refreshedAt: new Date().toISOString(), count: Object.keys(byEan).length, byEan };
  try { await writeJsonBlob(OFFER_MAP_PATH, map); } catch (_) {}
  return { ok: true, count: map.count };
}

function isOfferMapFresh(map) { return map?.refreshedAt && (Date.now() - new Date(map.refreshedAt).getTime()) < OFFER_MAP_MAX_AGE_MS; }

/**
 * Synchroniseer de bol-voorraad met de magazijnvoorraad.
 * @param {{dryRun?:boolean, onlyChanged?:boolean, refreshMap?:boolean}} opts
 *   dryRun (default true) → niets naar bol; toont alleen het plan.
 *   onlyChanged (default true) → push alleen waar bol-stock ≠ magazijn.
 */
export async function runBolStockSync({ dryRun = true, onlyChanged = true, refreshMap = false } = {}) {
  const plan = await buildBolStockPlan();

  if (dryRun) {
    /* Dry-run: koppel aan de (eventueel gecachte) offer-map om te tonen wat zou wijzigen. */
    const map = (await readJsonBlob(OFFER_MAP_PATH, null))?.byEan || {};
    const heeftMap = Object.keys(map).length > 0;
    const voorbeeld = plan.items.slice(0, 200).map((it) => {
      const o = map[it.ean];
      return { ...it, offerId: o?.offerId || null, bolVoorraad: o ? o.stock : null, wijzigt: o ? o.stock !== it.magazijnVoorraad : null };
    });
    const teWijzigen = heeftMap ? plan.items.filter((it) => { const o = map[it.ean]; return o && o.stock !== it.magazijnVoorraad; }).length : null;
    return { dryRun: true, principe: plan.principe, totaal: plan.totaal, metVoorraad: plan.metVoorraad, heeftOfferMap: heeftMap, teWijzigen, voorbeeld };
  }

  if (!isBolConfigured()) throw new Error('bol niet gekoppeld — kan niet live syncen.');

  /* Offer-map up-to-date houden. */
  let mapBlob = await readJsonBlob(OFFER_MAP_PATH, null);
  if (refreshMap || !mapBlob || !isOfferMapFresh(mapBlob)) {
    const rm = await refreshBolOfferMap();
    if (rm.ok) mapBlob = await readJsonBlob(OFFER_MAP_PATH, null);
    else if (!mapBlob) return { dryRun: false, ok: false, message: rm.message || `offer-map niet beschikbaar (${rm.reason || 'onbekend'})` };
  }
  const map = mapBlob?.byEan || {};

  let gepusht = 0, overgeslagen = 0, fouten = 0;
  const resultaten = [];
  for (const it of plan.items) {
    const o = map[it.ean];
    if (!o) { overgeslagen += 1; continue; } /* geen bol-offer voor deze EAN */
    if (onlyChanged && o.stock === it.magazijnVoorraad) { overgeslagen += 1; continue; }
    if (gepusht >= MAX_PUSH) break;
    try {
      await bolPost(`/offers/${o.offerId}/stock`, { amount: it.magazijnVoorraad, managedByRetailer: true }, { method: 'PUT' });
      gepusht += 1;
      o.stock = it.magazijnVoorraad; /* lokaal bijwerken */
      if (resultaten.length < 200) resultaten.push({ ean: it.ean, offerId: o.offerId, naar: it.magazijnVoorraad });
    } catch (e) {
      fouten += 1;
      if (resultaten.length < 200) resultaten.push({ ean: it.ean, offerId: o.offerId, error: e.message });
    }
  }
  /* Bijgewerkte map terugschrijven (cache van actuele bol-stock). */
  try { if (mapBlob) await writeJsonBlob(OFFER_MAP_PATH, { ...mapBlob, byEan: map }); } catch (_) {}

  return { dryRun: false, ok: true, principe: plan.principe, totaal: plan.totaal, gepusht, overgeslagen, fouten, resultaten };
}
