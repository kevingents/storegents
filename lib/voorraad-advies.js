/**
 * lib/voorraad-advies.js
 *
 * Rijk advertentie-/voorraad-advies per fysieke winkel door de SRS-verkopen
 * (verkoopsnelheid per SKU) te kruisen met de voorraad-snapshot en de Shopify
 * productcache (barcode → maat). Berekend in de dagelijkse retail-import en
 * gecachet in blob srs/voorraad-advies.json.
 *
 * Per winkel:
 *   - hardmover/slowmover-% (op voorraad)
 *   - voorraaddekking in dagen (days of supply)
 *   - top verkochte maten die op voorraad liggen
 *   - kansen (veel voorraad + verkoopt → veilig pushen)
 *   - overvoorraad (veel voorraad t.o.v. target / dode voorraad)
 *   - maat-gaten (verkocht maar niet meer op voorraad)
 * Plus een keten-brede 'global' rollup + niet-adverteren-lijst (bijna leeg).
 *
 * Join-sleutel: SRS sku_code === voorraad.sku === Shopify variant.barcode.
 */

import { readJsonBlob } from './json-blob-store.js';
import { getStoreNameByBranchId } from './branch-metrics.js';

export const VOORRAAD_ADVIES_PATH = 'srs/voorraad-advies.json';

const HARD_DAYS = 21;   /* verkoopt binnen ~3 weken uit → hardmover */
const DEAD_DAYS = 120;  /* >4 maanden voorraad bij dit tempo → slowmover */
const TOP_STORE = 5;
const TOP_GLOBAL = 15;

const clean = (v) => String(v == null ? '' : v).trim();
const lc = (v) => clean(v).toLowerCase();
const toInt = (v) => { const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : 0; };
const round1 = (n) => Math.round((Number(n) || 0) * 10) / 10;

export async function readVoorraadAdvies() {
  const d = await readJsonBlob(VOORRAAD_ADVIES_PATH, { filialen: [], totals: null, global: null, generatedAt: null });
  return (d && typeof d === 'object' && !Array.isArray(d)) ? d : { filialen: [], totals: null, global: null, generatedAt: null };
}

/* Days-of-supply: hoeveel dagen voorraad bij het huidige verkooptempo. */
function daysOfSupply(stock, sold, windowDays) {
  if (stock <= 0) return 0;
  const rate = sold / windowDays;
  return rate > 0 ? stock / rate : Infinity;
}

/* Classificeer één in-voorraad SKU. */
function classify(stock, sold, windowDays) {
  const dos = daysOfSupply(stock, sold, windowDays);
  return {
    dos,
    hard: sold > 0 && dos <= HARD_DAYS,
    slow: stock > 0 && (sold === 0 || dos > DEAD_DAYS)
  };
}

function labelFor(sku, byBarcode) {
  const info = byBarcode[lc(sku)] || {};
  const head = clean(info.articleNumber) || clean(info.title) || sku;
  return {
    sku,
    label: head,
    title: clean(info.title),
    size: clean(info.size),
    color: clean(info.color)
  };
}

/* Top-N maten uit een sold-by-size + stock-by-size map. */
function topSizes(soldBySize, stockBySize, n) {
  return [...soldBySize.entries()]
    .map(([size, sold]) => ({ size, sold, inStock: stockBySize.get(size) || 0 }))
    .filter((s) => s.size && s.inStock > 0)
    .sort((a, b) => b.sold - a.sold)
    .slice(0, n);
}

function sizeGaps(soldBySize, stockBySize, n) {
  return [...soldBySize.entries()]
    .map(([size, sold]) => ({ size, sold, inStock: stockBySize.get(size) || 0 }))
    .filter((s) => s.size && s.sold > 0 && s.inStock <= 0)
    .sort((a, b) => b.sold - a.sold)
    .slice(0, n);
}

/* Natuurlijke maat-sortering: numeriek (46,48) eerst, dan letters (XS→XXL). */
const SIZE_ORDER = ['xxxs', 'xxs', 'xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl', '3xl', '4xl', '5xl'];
function sizeRank(size) {
  const v = lc(size);
  const num = parseFloat(v.replace(',', '.'));
  if (Number.isFinite(num) && /^\d/.test(v)) return num;
  const i = SIZE_ORDER.indexOf(v);
  return i >= 0 ? 1000 + i : 5000;
}

/* Maat-matrix per winkel: alle maten met voorraad + verkocht naast elkaar. */
function buildMatrix(stockBySize, soldBySize, n = 24) {
  const sizes = new Set([...stockBySize.keys(), ...soldBySize.keys()].filter(Boolean));
  return [...sizes]
    .map((size) => ({ size, voorraad: stockBySize.get(size) || 0, verkocht: soldBySize.get(size) || 0 }))
    .sort((a, b) => (sizeRank(a.size) - sizeRank(b.size)) || a.size.localeCompare(b.size, 'nl'))
    .slice(0, n);
}

/* Status (backward-compatible met de oude thin-advies kleuren). */
function deriveStatus(outPct, underPct, hardNearEmptyPct) {
  if (outPct >= 0.15 || underPct >= 0.40 || hardNearEmptyPct >= 0.15) return 'slecht';
  if (underPct >= 0.20 || outPct >= 0.07) return 'matig';
  return 'goed';
}

function adviesText(status, hardPct, slowPct) {
  if (status === 'slecht') return 'Voorraad krap: veel hardmovers raken leeg / onder target. Eerst aanvullen — adverteren stuurt klanten naar lege schappen.';
  if (status === 'matig') return `Redelijk: ${Math.round(hardPct * 100)}% hardmovers, ${Math.round(slowPct * 100)}% stilstaand. Adverteer gericht op de goed-gevulde kansen.`;
  return `Gezond: ${Math.round(hardPct * 100)}% hardmovers met dekking. Goed moment om te adverteren of budget te verhogen op de kansen.`;
}

/**
 * @param {Object} p
 * @param {Array}  p.verkopen      ruwe verkopen-rijen (filiaal_nummer, sku_code, datum, verkoop_soort, aantal)
 * @param {Array}  p.voorraadRows  { filiaalNummer, store, sku, voorraad, ideaal }
 * @param {Object} p.byBarcode     productcache index: barcode(lc) → { size, color, title, articleNumber }
 * @param {Set}    p.physical      set van fysieke filiaal-ids (strings)
 * @param {Object} [p.window]      { from, to } (YYYY-MM-DD) — filtert verkopen
 * @param {number} [p.windowDays]  default 14
 */
export function computeVoorraadAdvies({ verkopen = [], voorraadRows = [], byBarcode = {}, physical, window = null, windowDays = 14 } = {}) {
  const isPhysical = (fil) => (physical ? physical.has(String(fil)) : true);
  const inWin = (window && window.from && window.to) ? (d) => d >= window.from && d <= window.to : () => true;

  /* Verkochte stuks per filiaal+sku en keten-breed per sku. */
  const salesFil = new Map();      /* fil → Map(sku → units) */
  const salesSkuChain = new Map(); /* sku → units (keten) */
  for (const r of verkopen) {
    const fil = clean(r.filiaal_nummer);
    if (!isPhysical(fil) || !inWin(clean(r.datum))) continue;
    if (lc(r.verkoop_soort) !== 'verkoop') continue;
    const units = toInt(r.aantal);
    if (units <= 0) continue;
    const sku = clean(r.sku_code);
    if (!sku) continue;
    if (!salesFil.has(fil)) salesFil.set(fil, new Map());
    const m = salesFil.get(fil);
    m.set(sku, (m.get(sku) || 0) + units);
    salesSkuChain.set(sku, (salesSkuChain.get(sku) || 0) + units);
  }

  /* Voorraad per filiaal + keten-breed per sku. */
  const stockFil = new Map();      /* fil → [{ sku, voorraad, ideaal }] */
  const stockSkuChain = new Map(); /* sku → { voorraad, ideaal } (keten) */
  for (const r of voorraadRows) {
    const fil = clean(r.filiaalNummer);
    if (!isPhysical(fil)) continue;
    const sku = clean(r.sku);
    if (!sku) continue;
    const voorraad = Number(r.voorraad) || 0;
    const ideaal = Number(r.ideaal) || 0;
    if (!stockFil.has(fil)) stockFil.set(fil, []);
    stockFil.get(fil).push({ sku, voorraad, ideaal });
    const c = stockSkuChain.get(sku) || { voorraad: 0, ideaal: 0 };
    c.voorraad += voorraad; c.ideaal += ideaal;
    stockSkuChain.set(sku, c);
  }

  /* ── Per filiaal ── */
  const filialen = [];
  for (const [fil, rows] of stockFil.entries()) {
    const sales = salesFil.get(fil) || new Map();
    const inStock = rows.filter((r) => r.voorraad > 0);
    const withTarget = rows.filter((r) => r.ideaal > 0);
    const out = withTarget.filter((r) => r.voorraad === 0).length;
    const under = withTarget.filter((r) => r.voorraad < r.ideaal).length;

    let hard = 0, slow = 0, hardNearEmpty = 0, totalStock = 0, totalSold = 0;
    const soldBySize = new Map();
    const stockBySize = new Map();
    const kansen = [], overvoorraad = [];

    for (const r of inStock) {
      const sold = sales.get(r.sku) || 0;
      const c = classify(r.voorraad, sold, windowDays);
      totalStock += r.voorraad; totalSold += sold;
      if (c.hard) { hard += 1; if (c.dos <= 14) hardNearEmpty += 1; }
      if (c.slow) slow += 1;
      const size = clean((byBarcode[lc(r.sku)] || {}).size);
      if (size) stockBySize.set(size, (stockBySize.get(size) || 0) + r.voorraad);
      /* Kans = gezonde dekking + bewezen verkoop. */
      if (sold > 0 && c.dos >= 30) kansen.push({ ...labelFor(r.sku, byBarcode), voorraad: r.voorraad, sold });
      /* Overvoorraad = boven target, of een dode stapel. */
      const over = r.ideaal > 0 ? (r.voorraad - r.ideaal) : 0;
      if ((over >= 2) || (sold === 0 && r.voorraad >= 5)) {
        overvoorraad.push({ ...labelFor(r.sku, byBarcode), voorraad: r.voorraad, ideaal: r.ideaal, over: Math.max(over, 0), sold });
      }
    }
    for (const [sku, units] of sales.entries()) {
      const size = clean((byBarcode[lc(sku)] || {}).size);
      if (size) soldBySize.set(size, (soldBySize.get(size) || 0) + units);
    }

    const inStockN = inStock.length || 1;
    const hardPct = hard / inStockN;
    const slowPct = slow / inStockN;
    const outPct = withTarget.length ? out / withTarget.length : 0;
    const underPct = withTarget.length ? under / withTarget.length : 0;
    const status = deriveStatus(outPct, underPct, hardNearEmpty / inStockN);
    const dekkingDagen = totalSold > 0 ? round1((totalStock / totalSold) * windowDays) : null;

    filialen.push({
      filiaalNummer: fil,
      store: getStoreNameByBranchId(fil),
      status,
      advies: adviesText(status, hardPct, slowPct),
      hardmovers: hard,
      slowmovers: slow,
      hardmoverPct: round1(hardPct * 100),
      slowmoverPct: round1(slowPct * 100),
      inStockSkus: inStock.length,
      dekkingDagen,
      signals: {
        totalSkus: rows.length,
        uitverkocht: out,
        onderTarget: under,
        overvoorraadSkus: overvoorraad.length,
        verkochtStuks: totalSold
      },
      topMaten: topSizes(soldBySize, stockBySize, TOP_STORE),
      maatMatrix: buildMatrix(stockBySize, soldBySize),
      maatGaten: sizeGaps(soldBySize, stockBySize, TOP_STORE),
      kansen: kansen.sort((a, b) => b.sold - a.sold).slice(0, TOP_STORE),
      overvoorraad: overvoorraad.sort((a, b) => (b.over - a.over) || (b.voorraad - a.voorraad)).slice(0, TOP_STORE)
    });
  }
  filialen.sort((a, b) => a.store.localeCompare(b.store, 'nl'));

  /* ── Keten-brede rollup ── */
  const chainSoldBySize = new Map();
  const chainStockBySize = new Map();
  const kansenG = [], nietAdverteren = [], overvoorraadG = [];
  for (const [sku, c] of stockSkuChain.entries()) {
    const sold = salesSkuChain.get(sku) || 0;
    const cl = classify(c.voorraad, sold, windowDays);
    const size = clean((byBarcode[lc(sku)] || {}).size);
    if (c.voorraad > 0 && size) chainStockBySize.set(size, (chainStockBySize.get(size) || 0) + c.voorraad);
    if (cl.hard && cl.dos >= HARD_DAYS) kansenG.push({ ...labelFor(sku, byBarcode), voorraad: c.voorraad, sold });
    else if (sold > 0 && cl.dos >= 30) kansenG.push({ ...labelFor(sku, byBarcode), voorraad: c.voorraad, sold });
    if (cl.hard && cl.dos <= 14) nietAdverteren.push({ ...labelFor(sku, byBarcode), voorraad: c.voorraad, sold, dagen: round1(cl.dos) });
    const over = c.ideaal > 0 ? (c.voorraad - c.ideaal) : 0;
    if ((over >= 3) || (sold === 0 && c.voorraad >= 8)) overvoorraadG.push({ ...labelFor(sku, byBarcode), voorraad: c.voorraad, ideaal: c.ideaal, over: Math.max(over, 0), sold });
  }
  for (const [sku, units] of salesSkuChain.entries()) {
    const size = clean((byBarcode[lc(sku)] || {}).size);
    if (size) chainSoldBySize.set(size, (chainSoldBySize.get(size) || 0) + units);
  }

  const totHard = filialen.reduce((n, f) => n + f.hardmovers, 0);
  const totSlow = filialen.reduce((n, f) => n + f.slowmovers, 0);
  const totIn = filialen.reduce((n, f) => n + f.inStockSkus, 0) || 1;
  const totStock = [...stockSkuChain.values()].reduce((n, c) => n + Math.max(0, c.voorraad), 0);
  const totSold = [...salesSkuChain.values()].reduce((n, u) => n + u, 0);

  return {
    generatedAt: new Date().toISOString(),
    window,
    windowDays,
    filialen,
    totals: {
      winkels: filialen.length,
      hardmoverPct: round1((totHard / totIn) * 100),
      slowmoverPct: round1((totSlow / totIn) * 100),
      dekkingDagen: totSold > 0 ? round1((totStock / totSold) * windowDays) : null
    },
    global: {
      topMaten: topSizes(chainSoldBySize, chainStockBySize, TOP_GLOBAL),
      maatGaten: sizeGaps(chainSoldBySize, chainStockBySize, TOP_GLOBAL),
      kansen: kansenG.sort((a, b) => b.sold - a.sold).slice(0, TOP_GLOBAL),
      nietAdverteren: nietAdverteren.sort((a, b) => a.dagen - b.dagen).slice(0, TOP_GLOBAL),
      overvoorraad: overvoorraadG.sort((a, b) => (b.over - a.over) || (b.voorraad - a.voorraad)).slice(0, TOP_GLOBAL)
    }
  };
}
