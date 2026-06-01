/**
 * lib/merchandiser.js
 *
 * Slimme merchandising-analyses bovenop de bestaande voorraad- + verkoop-data.
 * Geen nieuwe imports nodig — leest de blobs die de dagelijkse SRS-crons al vullen:
 *   - srs-voorraad/rows-latest.json   (per-SKU per-winkel: voorraad, ideaal, tekort)
 *   - srs-voorraad/summary-latest.json (per-filiaal gezondheid)
 *   - srs/voorraad-advies.json        (hardmover/slowmover/dekking/maatgaten/kansen/overvoorraad)
 *   - marketing/product-cost.json     (kostprijs per EAN → € waarde van voorraad/herverdeling)
 *   - shopify-products/cache.json     (leesbare artikelnaam/kleur/maat per SKU)
 *
 * Tools:
 *   1. HERVERDELING — winkel↔winkel: dode/overtollige voorraad in winkel A naar
 *      winkel B die het artikel tekortkomt (SRS-ideaal als vraagsignaal).
 *   2. MISGRIJPEN   — SKU's met voorraad ≤ 0 terwijl ideaal > 0 (kan niet verkopen);
 *      met label "elders beschikbaar → herverdeel" of "bijbestellen".
 *   3. DOORVERKOOP  — per winkel: hardmover/slowmover-%, dekking in dagen, status,
 *      kansen, overvoorraad (+ € vastgelegd kapitaal).
 */

import { readVoorraadRows, readVoorraadSummary } from './srs-voorraad-store.js';
import { readVoorraadAdvies } from './voorraad-advies.js';
import { readProductCost } from './product-cost-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { readVelocity, soldFor } from './verkoop-velocity-store.js';
import { listBranches } from './branch-metrics.js';

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n) || 0;

/* ── Helpers ─────────────────────────────────────────────────────────────── */

export function physicalBranchSet() {
  const set = new Set();
  try {
    for (const b of listBranches({ includeInternal: false })) set.add(String(b.branchId));
  } catch { /* leeg → geen filter */ }
  return set;
}

function labelForSku(sku, cacheBySku) {
  const e = cacheBySku && cacheBySku[String(sku || '').toLowerCase()];
  if (!e) return { label: String(sku || ''), artikel: '', color: '', size: '', articleNumber: '', productType: '', image: '' };
  const artikel = e.title || e.productHandle || String(sku || '');
  const parts = [artikel];
  if (e.color) parts.push(e.color);
  if (e.size) parts.push(e.size);
  return {
    label: parts.filter(Boolean).join(' · '),
    artikel, color: e.color || '', size: e.size || '',
    articleNumber: e.articleNumber || e.srsRveArtikelnummer || '',
    productType: e.productType || '', image: e.image || ''
  };
}
function kostprijsFor(sku, costBySku) {
  const e = costBySku && costBySku[String(sku || '')];
  return e && e.kostprijs ? num(e.kostprijs) : 0;
}

/* ── 1. HERVERDELING (winkel ↔ winkel) ───────────────────────────────────── */
/**
 * Per SKU: winkels met overschot (voorraad > ideaal) doneren aan winkels met
 * tekort (ideaal > voorraad). Greedy: grootste overschot → grootste tekort.
 * Alleen fysieke winkels (magazijn/showroom/intern uitgesloten).
 *
 * @returns {{ suggestions, summary }}
 */
export function buildRedistribution(rows, { cacheBySku = {}, costBySku = {}, physical = null, velocity = null, minUnits = 1, maxSuggestions = 300 } = {}) {
  const bySku = new Map();
  for (const r of rows || []) {
    const fil = String(r.filiaalNummer);
    if (physical && physical.size && !physical.has(fil)) continue; /* alleen winkels */
    const ideaal = num(r.ideaal), voorraad = num(r.voorraad);
    if (ideaal <= 0 && voorraad <= 0) continue;
    if (!bySku.has(r.sku)) bySku.set(r.sku, []);
    bySku.get(r.sku).push({ fil, store: r.store || `Filiaal ${fil}`, voorraad, ideaal });
  }

  const suggestions = [];
  const routeAgg = new Map(); /* "van→naar" → {van, naar, units, value, lijnen} */
  let totalUnits = 0, totalValue = 0;

  for (const [sku, list] of bySku) {
    /* Donoren: overschot = voorraad − max(ideaal,0), houden eigen ideaal aan. */
    const donors = [];
    const receivers = [];
    for (const x of list) {
      const surplus = x.voorraad - Math.max(x.ideaal, 0);
      const tekort = Math.max(x.ideaal, 0) - x.voorraad;
      if (surplus >= 1 && x.voorraad > 0) donors.push({ ...x, avail: Math.floor(surplus) });
      else if (tekort >= 1) receivers.push({ ...x, need: Math.floor(tekort) });
    }
    if (!donors.length || !receivers.length) continue;
    donors.sort((a, b) => b.avail - a.avail);
    receivers.sort((a, b) => b.need - a.need);

    const kp = kostprijsFor(sku, costBySku);
    const lab = labelForSku(sku, cacheBySku);
    let di = 0;
    for (const rec of receivers) {
      let need = rec.need;
      const soldNaar = velocity ? soldFor(velocity, sku, rec.fil) : null;
      while (need >= 1 && di < donors.length) {
        const don = donors[di];
        if (don.avail < 1) { di++; continue; }
        const move = Math.min(need, don.avail);
        if (move >= minUnits) {
          const soldVan = velocity ? soldFor(velocity, sku, don.fil) : null;
          /* Prioriteit: hoog = staat stil bij A maar verkoopt bij B. */
          let prioriteit = null, prio = 0;
          if (velocity) {
            if (soldVan === 0 && soldNaar > 0) { prioriteit = 'hoog'; prio = 3; }
            else if (soldNaar > 0) { prioriteit = 'midden'; prio = 2; }
            else { prioriteit = 'laag'; prio = 1; }
          }
          suggestions.push({
            sku, label: lab.label, artikel: lab.artikel, color: lab.color, size: lab.size,
            articleNumber: lab.articleNumber, productType: lab.productType,
            vanFil: don.fil, van: don.store, naarFil: rec.fil, naar: rec.store,
            units: move, kostprijs: kp || null, value: kp ? round2(move * kp) : null,
            verkochtVan: soldVan, verkochtNaar: soldNaar, prioriteit, _prio: prio
          });
          totalUnits += move; totalValue += kp ? move * kp : 0;
          const key = don.store + ' → ' + rec.store;
          const ra = routeAgg.get(key) || { van: don.store, naar: rec.store, units: 0, value: 0, lijnen: 0 };
          ra.units += move; ra.value += kp ? move * kp : 0; ra.lijnen += 1;
          routeAgg.set(key, ra);
        }
        don.avail -= move; need -= move;
        if (don.avail < 1) di++;
      }
      if (di >= donors.length) break;
    }
  }

  suggestions.sort((a, b) => (b._prio || 0) - (a._prio || 0) || (b.value || 0) - (a.value || 0) || b.units - a.units);
  suggestions.forEach((s) => { delete s._prio; });
  const routes = [...routeAgg.values()].map((r) => ({ ...r, value: round2(r.value) })).sort((a, b) => b.units - a.units);

  return {
    suggestions: suggestions.slice(0, maxSuggestions),
    summary: {
      lijnen: suggestions.length,
      units: totalUnits,
      value: round2(totalValue),
      routes: routes.slice(0, 40),
      getoond: Math.min(suggestions.length, maxSuggestions)
    }
  };
}

/* ── 2. MISGRIJPEN (out-of-stock terwijl ideaal > 0) ─────────────────────── */
export function buildStockoutRisk(rows, { cacheBySku = {}, costBySku = {}, physical = null, maxItems = 300 } = {}) {
  /* Chain-brede beschikbaarheid per sku: overschot in andere winkels + magazijn. */
  const surplusBySku = new Map();   /* sku → units beschikbaar (winkel-overschot) */
  const magazijnBySku = new Map();  /* sku → units in magazijn/intern */
  for (const r of rows || []) {
    const fil = String(r.filiaalNummer);
    const voorraad = num(r.voorraad), ideaal = num(r.ideaal);
    const isPhys = !physical || !physical.size || physical.has(fil);
    if (isPhys) {
      const surplus = voorraad - Math.max(ideaal, 0);
      if (surplus >= 1) surplusBySku.set(r.sku, (surplusBySku.get(r.sku) || 0) + Math.floor(surplus));
    } else if (voorraad > 0) {
      magazijnBySku.set(r.sku, (magazijnBySku.get(r.sku) || 0) + Math.floor(voorraad));
    }
  }

  const items = [];
  let total = 0, herverdeelbaar = 0, bijbestellen = 0;
  for (const r of rows || []) {
    const fil = String(r.filiaalNummer);
    if (physical && physical.size && !physical.has(fil)) continue;
    const voorraad = num(r.voorraad), ideaal = num(r.ideaal);
    if (!(voorraad <= 0 && ideaal > 0)) continue; /* alleen echte misgrijpers */
    total += 1;
    const elders = surplusBySku.get(r.sku) || 0;
    const magazijn = magazijnBySku.get(r.sku) || 0;
    const bron = elders > 0 ? 'herverdeel' : (magazijn > 0 ? 'magazijn' : 'bijbestellen');
    if (bron === 'bijbestellen') bijbestellen += 1; else herverdeelbaar += 1;
    const lab = labelForSku(r.sku, cacheBySku);
    const kp = kostprijsFor(r.sku, costBySku);
    items.push({
      sku: r.sku, label: lab.label, artikel: lab.artikel, color: lab.color, size: lab.size,
      articleNumber: lab.articleNumber, productType: lab.productType,
      fil, store: r.store || `Filiaal ${fil}`, voorraad, ideaal,
      gemist: ideaal, /* SRS-ideaal als vraag-proxy */
      eldersBeschikbaar: elders, magazijnBeschikbaar: magazijn, bron,
      kostprijs: kp || null
    });
  }
  items.sort((a, b) => b.gemist - a.gemist || b.eldersBeschikbaar - a.eldersBeschikbaar);
  return {
    items: items.slice(0, maxItems),
    summary: { totaal: total, herverdeelbaar, bijbestellen, getoond: Math.min(items.length, maxItems) }
  };
}

/* ── 3. DOORVERKOOP (uit voorraad-advies) ────────────────────────────────── */
export function summarizeDoorverkoop(advies, { costBySku = {} } = {}) {
  const filialen = (advies && advies.filialen) || [];
  const overvoorraadValue = (list) => round2((list || []).reduce((s, o) => s + num(o.over) * kostprijsFor(o.sku, costBySku), 0));
  const rows = filialen.map((f) => ({
    filiaalNummer: f.filiaalNummer, store: f.store, status: f.status,
    hardmovers: f.hardmovers, slowmovers: f.slowmovers,
    hardmoverPct: f.hardmoverPct, slowmoverPct: f.slowmoverPct,
    dekkingDagen: f.dekkingDagen,
    kansen: (f.kansen || []).slice(0, 8),
    overvoorraad: (f.overvoorraad || []).slice(0, 8),
    overvoorraadValue: overvoorraadValue(f.overvoorraad),
    maatGaten: (f.maatGaten || []).slice(0, 12)
  })).sort((a, b) => (b.slowmoverPct || 0) - (a.slowmoverPct || 0));
  const g = (advies && advies.global) || null;
  return {
    filialen: rows,
    global: g ? {
      hardmoverPct: g.hardmoverPct, slowmoverPct: g.slowmoverPct, dekkingDagen: g.dekkingDagen,
      kansen: (g.kansen || []).slice(0, 10), overvoorraad: (g.overvoorraad || []).slice(0, 10),
      overvoorraadValue: overvoorraadValue(g.overvoorraad), maatGaten: (g.maatGaten || []).slice(0, 14)
    } : null,
    generatedAt: (advies && advies.generatedAt) || null
  };
}

/* ── Orchestrator ────────────────────────────────────────────────────────── */
/**
 * @param {string} view 'overview' | 'herverdeling' | 'misgrijpen' | 'doorverkoop'
 */
export async function buildMerchandiser(view = 'overview', { limit = 300 } = {}) {
  const physical = physicalBranchSet();
  const [rows, summary, advies, cost, cache, velocity] = await Promise.all([
    readVoorraadRows().catch(() => []),
    readVoorraadSummary().catch(() => ({ filialen: [], totals: {} })),
    readVoorraadAdvies().catch(() => ({ filialen: [], global: null, generatedAt: null })),
    readProductCost().catch(() => ({ bySku: {} })),
    readProductsCache().catch(() => ({ bySku: {} })),
    readVelocity().catch(() => null)
  ]);
  const cacheBySku = (cache && cache.bySku) || {};
  const costBySku = (cost && cost.bySku) || {};
  const meta = { voorraadAt: summary && summary.generatedAt, adviesAt: advies && advies.generatedAt, velocityAt: velocity && velocity.generatedAt, velocityDagen: velocity && velocity.windowDays, rijen: rows.length };

  if (view === 'herverdeling') {
    return { view, ...buildRedistribution(rows, { cacheBySku, costBySku, physical, velocity, maxSuggestions: limit }), meta };
  }
  if (view === 'misgrijpen') {
    return { view, ...buildStockoutRisk(rows, { cacheBySku, costBySku, physical, maxItems: limit }), meta };
  }
  if (view === 'doorverkoop') {
    return { view, ...summarizeDoorverkoop(advies, { costBySku }), meta };
  }

  /* overview: compacte samenvatting van alles. */
  const herv = buildRedistribution(rows, { cacheBySku, costBySku, physical, velocity, maxSuggestions: 8 });
  const miss = buildStockoutRisk(rows, { cacheBySku, costBySku, physical, maxItems: 8 });
  const dv = summarizeDoorverkoop(advies, { costBySku });
  const t = (summary && summary.totals) || {};
  return {
    view: 'overview',
    voorraad: {
      totalSkus: t.totalSkus || null, totalStock: t.totalStock || null,
      skusOutOfStock: t.skusOutOfStock || null, skusNegative: t.skusNegative || null,
      skusOverIdeal: t.skusOverIdeal || null, overstockUnits: t.overstockUnits || null,
      shortageUnits: t.shortageUnits || null
    },
    herverdeling: { ...herv.summary, top: herv.suggestions },
    misgrijpen: { ...miss.summary, top: miss.items },
    doorverkoop: dv.global,
    overvoorraadValue: dv.global ? dv.global.overvoorraadValue : null,
    meta
  };
}
