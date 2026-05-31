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

const PATH = 'marketplace/bol-returns.json';
const MAX_AGE_MS = Number(process.env.BOL_RETURNS_MAX_AGE_MS || 6 * 60 * 60 * 1000);
const MAX_PAGES = Number(process.env.BOL_RETURNS_MAX_PAGES || 10);

const clean = (v) => String(v == null ? '' : v).trim();

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

  const [returns, cache] = await Promise.all([fetchAllReturns(), readProductsCache().catch(() => null)]);
  const byBarcode = (cache && cache.byBarcode) || {};

  const byEan = new Map(); /* ean → { ean, title, aantal, retouren, redenen:Map } */
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
        e = { ean, title: v ? v.title : '', aantal: 0, retouren: 0, redenen: new Map() };
        byEan.set(ean, e);
      }
      e.aantal += qty;
      e.retouren += 1;
      e.redenen.set(reason, (e.redenen.get(reason) || 0) + qty);
    }
  }

  const producten = [...byEan.values()].map((e) => ({
    ean: e.ean,
    titel: e.title || '(onbekend — niet in Shopify-cache)',
    aantalRetour: e.aantal,
    retourRegels: e.retouren,
    topReden: [...e.redenen.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '',
    redenen: Object.fromEntries([...e.redenen.entries()].sort((a, b) => b[1] - a[1]))
  })).sort((a, b) => b.aantalRetour - a.aantalRetour);

  /* Reden-totalen over alles. */
  const redenTotalen = {};
  for (const p of producten) for (const [r, n] of Object.entries(p.redenen)) redenTotalen[r] = (redenTotalen[r] || 0) + n;

  /* Content-verbeterkandidaten: retouren door 'past niet' / 'niet zoals
     verwacht' / 'verkeerd product' wijzen vaak op een content-gat (maattabel,
     foto's, omschrijving). Die producten verdienen betere bol-content. */
  const CONTENT_REASONS = new Set(['DOES_NOT_FIT', 'PRODUCT_NOT_AS_EXPECTED', 'WRONG_PRODUCT', 'RECEIVED_WRONG_PRODUCT', 'PRODUCT_NOT_AS_DESCRIBED']);
  const contentKandidaten = producten.map((p) => ({
    ean: p.ean, titel: p.titel,
    contentAantal: Object.entries(p.redenen).filter(([r]) => CONTENT_REASONS.has(r)).reduce((n, [, c]) => n + c, 0),
    aantalRetour: p.aantalRetour, topReden: p.topReden
  })).filter((p) => p.contentAantal > 0).sort((a, b) => b.contentAantal - a.contentAantal).slice(0, 50);

  const result = {
    configured: true,
    refreshedAt: new Date().toISOString(),
    totaalRetouren, totaalItems,
    uniekeProducten: producten.length,
    redenTotalen: Object.fromEntries(Object.entries(redenTotalen).sort((a, b) => b[1] - a[1])),
    /* "beter niet verkopen": de zwaarste retour-producten. */
    nietVerkopen: producten.slice(0, 50),
    contentKandidaten,
    producten: producten.slice(0, 500)
  };

  try { await writeJsonBlob(PATH, result); } catch (_) {}
  return result;
}

export async function readBolReturns() { return readJsonBlob(PATH, null); }
export function isBolReturnsFresh(d) { return d?.refreshedAt && (Date.now() - new Date(d.refreshedAt).getTime()) < MAX_AGE_MS; }
