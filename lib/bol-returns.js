/**
 * lib/bol-returns.js
 *
 * Retouranalyse voor bol.com: haalt retouren op (open + afgehandeld),
 * aggregeert per EAN met reden-uitsplitsing, verrijkt met de Shopify-
 * producttitel (via barcode = EAN), en markeert producten met veel retouren —
 * kandidaten om "beter niet (meer) te verkopen". Read-only, blob-gecached.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { bolGet, getBolConfig } from './bol-client.js';
import { readProductsCache } from './shopify-products-cache.js';
import { readVoorraadRows } from './srs-voorraad-store.js';
import { listBranchesFromConfig } from './business-config.js';

const PATH = 'marketplace/bol-returns.json';
const MAX_AGE_MS = Number(process.env.BOL_RETURNS_MAX_AGE_MS || 6 * 60 * 60 * 1000);
const MAX_PAGES = Number(process.env.BOL_RETURNS_MAX_PAGES || 10);

const clean = (v) => String(v == null ? '' : v).trim();
const skuKey = (v) => clean(v).toLowerCase();

/* Magazijnvoorraad per SKU uit de SRS-snapshot (zelfde bron als de stock-sync). */
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
  return bySku;
}

async function fetchAllReturns() {
  const out = [];
  for (const handled of [false, true]) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      let data;
      try { data = await bolGet('/returns', { query: { handled: String(handled) }, page }); }
      catch (e) { if (page === 1 && !handled) throw e; break; }
      const rows = data?.returns || [];
      if (!rows.length) break;
      for (const r of rows) out.push(r);
      if (rows.length < 50) break; /* laatste pagina */
    }
  }
  return out;
}

export async function runBolReturns() {
  const cfg = getBolConfig();
  if (!cfg.configured) return { configured: false, reason: `Niet gekoppeld — ontbrekend: ${cfg.missing.join(', ')}` };

  const [returns, cache, voorraadRows] = await Promise.all([
    fetchAllReturns(),
    readProductsCache().catch(() => null),
    readVoorraadRows().catch(() => [])
  ]);
  const byBarcode = (cache && cache.byBarcode) || {};
  const stockBySku = warehouseStockBySku(voorraadRows);

  const byEan = new Map(); /* ean → { ean, title, image, maat, kleur, voorraad, aantal, retouren, redenen:Map } */
  let totaalRetouren = 0, totaalItems = 0;

  for (const r of returns) {
    totaalRetouren += 1;
    for (const it of (r.returnItems || [])) {
      const ean = clean(it.ean);
      if (!ean) continue;
      const qty = Number(it.quantity ?? it.expectedQuantity ?? 1) || 1;
      const reason = clean(it.returnReason?.mainReason || it.returnReason?.detailedReason || 'ONBEKEND');
      totaalItems += qty;
      let e = byEan.get(ean);
      if (!e) {
        const v = byBarcode[ean.toLowerCase()] || null;
        const voorraad = v ? Math.max(0, Math.round(Number(stockBySku.get(skuKey(v.sku)) || 0))) : null;
        e = {
          ean, title: v ? v.title : '', family: v ? clean(v.productId) : '',
          image: v ? clean(v.image) : '', maat: v ? clean(v.size) : '', kleur: v ? clean(v.color) : '',
          voorraad, aantal: 0, retouren: 0, redenen: new Map()
        };
        byEan.set(ean, e);
      }
      e.aantal += qty;
      e.retouren += 1;
      e.redenen.set(reason, (e.redenen.get(reason) || 0) + qty);
    }
  }

  /* Reden-codes → nette NL-labels (bol levert codes/Engelse strings). */
  const REASON_LABELS = {
    DOES_NOT_FIT: 'Verkeerde maat of afmeting', TOO_SMALL: 'Te klein', TOO_LARGE: 'Te groot',
    PRODUCT_NOT_AS_EXPECTED: 'Niet zoals verwacht', PRODUCT_NOT_AS_DESCRIBED: 'Niet zoals omschreven',
    WRONG_PRODUCT: 'Verkeerd product', RECEIVED_WRONG_PRODUCT: 'Verkeerd product ontvangen',
    PRODUCT_DEFECT: 'Product defect', PRODUCT_DAMAGED: 'Beschadigd ontvangen',
    ARRIVED_TOO_LATE: 'Te laat geleverd', MISSING_PARTS: 'Onderdelen ontbreken',
    NO_REASON_GIVEN: 'Geen reden', CHANGED_MY_MIND: 'Toch niet nodig',
    FOUND_BETTER_PRICE: 'Elders goedkoper', OTHER: 'Anders', ONBEKEND: 'Onbekend'
  };
  const nl = (code) => REASON_LABELS[clean(code).toUpperCase()] || clean(code) || 'Onbekend';
  /* Maat-gerelateerde redenen → wijzen op een maattabel-gat (#1 retour-oorzaak). */
  const SIZE_REASONS = new Set(['DOES_NOT_FIT', 'TOO_SMALL', 'TOO_LARGE']);
  /* Overige content-gerelateerde retour-redenen → wijzen op een content-gat. */
  const CONTENT_REASONS = new Set(['DOES_NOT_FIT', 'TOO_SMALL', 'TOO_LARGE', 'PRODUCT_NOT_AS_EXPECTED', 'PRODUCT_NOT_AS_DESCRIBED', 'WRONG_PRODUCT', 'RECEIVED_WRONG_PRODUCT']);
  const GEEN_REDEN = new Set(['NO_REASON_GIVEN', 'OTHER', 'ONBEKEND', '']);
  const STOP_THRESHOLD = Number(process.env.BOL_RETURN_STOP || 15);
  /* Voorraadstatus uit magazijnvoorraad. */
  const voorraadStatus = (n) => n == null ? 'onbekend' : n <= 0 ? 'uit' : n <= 5 ? 'laag' : 'opVoorraad';

  const producten = [...byEan.values()].map((e) => {
    const sorted = [...e.redenen.entries()].sort((a, b) => b[1] - a[1]);
    const topCode = sorted[0]?.[0] || '';
    const aantalRetour = e.aantal;
    const contentAantal = sorted.filter(([r]) => CONTENT_REASONS.has(clean(r).toUpperCase())).reduce((n, [, c]) => n + c, 0);
    const maatAantal = sorted.filter(([r]) => SIZE_REASONS.has(clean(r).toUpperCase())).reduce((n, [, c]) => n + c, 0);
    /* Advies: heel veel retouren → stoppen; vooral maat-redenen → maattabel
       aanpassen; overige content-redenen → content verbeteren; onduidelijke
       reden → handmatig reviewen; anders stoppen. */
    const advies = aantalRetour >= STOP_THRESHOLD ? 'stoppen'
      : (maatAantal > 0 && maatAantal / aantalRetour >= 0.4) ? 'maattabel'
      : (contentAantal > 0 && contentAantal / aantalRetour >= 0.4) ? 'content'
      : GEEN_REDEN.has(clean(topCode).toUpperCase()) ? 'review'
      : 'stoppen';
    const prioriteit = aantalRetour >= 10 ? 'hoog' : aantalRetour >= 5 ? 'middel' : 'laag';
    const status = voorraadStatus(e.voorraad);
    return {
      ean: e.ean,
      family: e.family || '',
      titel: e.title || '(onbekend — niet in Shopify-cache)',
      afbeelding: e.image || '', maat: e.maat || '', kleur: e.kleur || '',
      voorraad: e.voorraad, voorraadstatus: status,
      aantalRetour, retourRegels: e.retouren,
      topReden: nl(topCode), topRedenPct: aantalRetour ? Math.round((sorted[0]?.[1] || 0) / aantalRetour * 100) : 0,
      contentAantal, maatAantal, advies, prioriteit,
      redenen: Object.fromEntries(sorted.map(([r, n]) => [nl(r), n]))
    };
  }).sort((a, b) => b.aantalRetour - a.aantalRetour);

  /* Reden-totalen over alles (nette labels). */
  const redenTotalen = {};
  for (const p of producten) for (const [r, n] of Object.entries(p.redenen)) redenTotalen[r] = (redenTotalen[r] || 0) + n;

  const totaalRetourRegels = producten.reduce((n, p) => n + p.retourRegels, 0);
  const metContentReden = producten.filter((p) => p.contentAantal > 0).length;
  const hoogKans = producten.filter((p) => p.contentAantal > 0 && p.aantalRetour >= 5).length;
  const teReviewen = producten.filter((p) => p.aantalRetour >= 5).length;

  /* Content-tab = content- én maattabel-adviezen (beide los te verbeteren). */
  const contentKandidaten = producten.filter((p) => p.advies === 'content' || p.advies === 'maattabel')
    .map((p) => ({ ean: p.ean, titel: p.titel, contentAantal: p.contentAantal, aantalRetour: p.aantalRetour, topReden: p.topReden, advies: p.advies }))
    .sort((a, b) => b.contentAantal - a.contentAantal).slice(0, 200);

  const maatProblemen = producten.filter((p) => p.advies === 'maattabel').length;
  const uitVoorraad = producten.filter((p) => p.voorraadstatus === 'uit').length;
  const stoppenAantal = producten.filter((p) => p.advies === 'stoppen').length;

  const result = {
    configured: true,
    refreshedAt: new Date().toISOString(),
    totaalRetouren, totaalItems,
    uniekeProducten: producten.length,
    totaalRetourRegels,
    redenTotalen: Object.fromEntries(Object.entries(redenTotalen).sort((a, b) => b[1] - a[1])),
    kansContentfix: { pct: producten.length ? Math.round((metContentReden / producten.length) * 100) : 0, hoogKans },
    teReviewen, maatProblemen, uitVoorraad, stoppenAantal,
    nietVerkopen: producten.filter((p) => p.advies === 'stoppen').slice(0, 200),
    contentKandidaten,
    producten: producten.slice(0, 400)
  };

  try { await writeJsonBlob(PATH, result); } catch (_) {}
  return result;
}

export async function readBolReturns() { return readJsonBlob(PATH, null); }
export function isBolReturnsFresh(d) { return d?.refreshedAt && (Date.now() - new Date(d.refreshedAt).getTime()) < MAX_AGE_MS; }
