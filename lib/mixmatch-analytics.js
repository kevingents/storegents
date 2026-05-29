/**
 * lib/mixmatch-analytics.js
 *
 * Voorraad-impact van Mix & Match-pakken. Kruist de colbert↔broek(↔gilet)-paren
 * (uit bundle-pairing, op SRSERP.artikel_id) met de voorraad-snapshot PER MAAT,
 * zodat we per pak zien hoeveel maten verkoopbaar zijn als compleet pakket.
 *
 * Model (maat-gekoppeld pak): een maat is verkoopbaar als ÁLLE onderdelen in die
 * maat voorraad hebben; verkoopbare stuks = min(voorraad per onderdeel). Zo
 * volgen beschikbaarheid%, lage voorraad (<5), uitverkochte maten en overstock.
 *
 * Bronnen: bundle-pairing (paren) · srs-voorraad-store (voorraad per sku=barcode)
 * · shopify-products-cache (barcode → artikel_id + maat) · mixmatch-store (eigen
 * pakketten, voor de "gelinkte styles"-telling).
 */

import { findBundlePairs } from './bundle-pairing.js';
import { readVoorraadRows, readVoorraadSummary } from './srs-voorraad-store.js';
import { readProductsCache } from './shopify-products-cache.js';
import { readPakketten, summarize } from './mixmatch-store.js';

const clean = (v) => String(v == null ? '' : v).trim();
const lc = (v) => clean(v).toLowerCase();

const LOW = 5;    /* < 5 verkoopbaar = lage voorraad */
const OVER = 15;  /* >= 15 verkoopbaar in één maat = overstock-signaal */

const roleLabel = (r) => (r === 'colbert' ? 'Colbert' : r === 'broek' ? 'Pantalon' : r === 'gilet' ? 'Gilet' : r);

export async function buildMixMatchAnalytics() {
  const [pairsData, voorraadRows, summary, cache, pak] = await Promise.all([
    findBundlePairs().catch(() => ({ pairs: [] })),
    readVoorraadRows().catch(() => []),
    readVoorraadSummary().catch(() => ({})),
    readProductsCache().catch(() => null),
    readPakketten().catch(() => ({ pakketten: [] }))
  ]);

  const byBarcode = cache?.byBarcode || {};

  /* Voorraad per artikel_id + maat (keten-breed, som over filialen). */
  const stock = new Map(); /* artId(lc) → Map(size → qty) */
  for (const r of (voorraadRows || [])) {
    const sku = lc(r.sku);
    if (!sku) continue;
    const v = byBarcode[sku];
    if (!v) continue;
    const art = lc(v.srsArtikelId);
    const qty = Number(r.voorraad) || 0;
    if (!art || qty <= 0) continue;
    const size = clean(v.size) || '—';
    if (!stock.has(art)) stock.set(art, new Map());
    const m = stock.get(art);
    m.set(size, (m.get(size) || 0) + qty);
  }
  const sizesOf = (artId) => stock.get(lc(artId)) || new Map();

  const pairs = pairsData.pairs || [];
  const enriched = [];
  const lowAlerts = [];
  const overAlerts = [];
  let sumBesch = 0;

  for (const p of pairs) {
    const comps = [p.colbert, p.broek, p.gilet].filter(Boolean);
    const maps = comps.map((c) => sizesOf(c.artikelId));
    const sizes = new Set();
    for (const m of maps) for (const s of m.keys()) if (s && s !== '—') sizes.add(s);

    let beschikbaar = 0, laag = 0, uitverkocht = 0, over = 0, sellable = 0;
    for (const s of sizes) {
      const parts = maps.map((m) => m.get(s) || 0);
      const minQ = parts.length ? Math.min(...parts) : 0;
      if (minQ > 0) { beschikbaar += 1; sellable += minQ; if (minQ < LOW) laag += 1; if (minQ >= OVER) over += 1; }
      else uitverkocht += 1;
    }
    const totaal = sizes.size || 1;
    const beschPct = Math.round((beschikbaar / totaal) * 100);
    sumBesch += beschPct;
    const status = beschPct < 50 ? 'risico' : beschPct < 75 ? 'letop' : 'goed';
    const impactScore = Math.round((1 - beschikbaar / totaal) * 100); /* hoe meer onbeschikbaar, hoe hoger de impact */
    const impact = impactScore >= 55 ? 'Hoog' : impactScore >= 30 ? 'Gemiddeld' : 'Laag';

    const slim = (c) => c ? { artikelId: c.artikelId, title: c.title, image: c.image } : null;
    const item = {
      code: p.code,
      type: p.threePiece ? '3-delig' : '2-delig',
      roles: comps.map((c) => c.role),
      combinatie: comps.map((c) => roleLabel(c.role)).join(' + '),
      colbert: slim(p.colbert), broek: slim(p.broek), gilet: slim(p.gilet),
      maten: totaal, beschikbaar, laag, uitverkocht, over, sellable, beschPct, status, impact, impactScore
    };
    enriched.push(item);

    const titel = (p.colbert && p.colbert.title) || (p.broek && p.broek.title) || p.code;
    if (laag) lowAlerts.push({ code: p.code, type: item.type, titel, combinatie: item.combinatie, beschikbaar, maten: totaal, laag });
    if (over) overAlerts.push({ code: p.code, type: item.type, titel, combinatie: item.combinatie, over, sellable });
  }

  const n = enriched.length || 1;
  const gemBeschikbaarheid = Math.round(sumBesch / n);
  const risico = enriched.filter((e) => e.status === 'risico').length;
  const lageVoorraad = enriched.filter((e) => e.laag > 0).length;
  const uitverkocht = enriched.filter((e) => e.beschikbaar === 0).length;
  const overstock = enriched.filter((e) => e.over > 0).length;

  /* Categorie-rollup (per combinatie-type, bv. "Colbert + Pantalon"). */
  const cat = new Map();
  for (const e of enriched) {
    let c = cat.get(e.combinatie);
    if (!c) { c = { combinatie: e.combinatie, type: e.type, pakketten: 0, beschikbaar: 0, laag: 0, uitverkocht: 0, sumBesch: 0, sellable: 0 }; cat.set(e.combinatie, c); }
    c.pakketten += 1; c.beschikbaar += e.beschikbaar; c.laag += e.laag; c.uitverkocht += e.uitverkocht; c.sumBesch += e.beschPct; c.sellable += e.sellable;
  }
  const categorieen = [...cat.values()].map((c) => {
    const gem = Math.round(c.sumBesch / (c.pakketten || 1));
    return {
      combinatie: c.combinatie, type: c.type, pakketten: c.pakketten,
      beschikbaar: c.beschikbaar, laag: c.laag, uitverkocht: c.uitverkocht, sellable: c.sellable,
      gemBeschikbaarheid: gem,
      impact: gem < 60 ? 'Hoog' : gem < 80 ? 'Gemiddeld' : 'Laag',
      status: gem < 50 ? 'risico' : gem < 75 ? 'letop' : 'goed'
    };
  }).sort((a, b) => b.sellable - a.sellable);

  const pakketten = pak.pakketten || [];
  const pakSummary = summarize(pakketten);

  return {
    generatedAt: new Date().toISOString(),
    voorraadAt: summary?.generatedAt || null,
    cacheAt: cache?.refreshedAt || null,
    totals: {
      mogelijkePakketten: enriched.length,
      gelinkteStyles: pakketten.length,
      actieveStyles: pakSummary.actief,
      artikelenInPakketten: pakSummary.artikelenInPakketten,
      gemBeschikbaarheid,
      risico,
      lageVoorraad,
      uitverkocht,
      overstock
    },
    /* Belangrijkste combinaties: grootste verkoopbaar volume eerst. */
    top: enriched.slice().sort((a, b) => b.sellable - a.sellable || b.impactScore - a.impactScore).slice(0, 12),
    categorieen: categorieen.slice(0, 20),
    lowAlerts: lowAlerts.sort((a, b) => a.beschikbaar - b.beschikbaar || b.laag - a.laag).slice(0, 20),
    overAlerts: overAlerts.sort((a, b) => b.over - a.over).slice(0, 20)
  };
}
