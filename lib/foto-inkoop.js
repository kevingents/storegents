/**
 * lib/foto-inkoop.js
 *
 * Foto-werklijst op basis van de inkooporders: welke ingekochte producten zijn
 * al gefotografeerd (staan met beeld op Shopify), welke moeten nog, en welke
 * staan nog helemaal niet op Shopify (nieuw — eerst aanmaken + fotograferen).
 *
 * Bron:
 *   - SRS PurchaseOrders (getPurchaseOrders) → regels met barcode/sku + aantallen.
 *   - Shopify productcache (readProductsCache) → titel/maat/kleur + foto-status.
 *
 * Join: PO-regel.barcode → cache.byBarcode, fallback PO-regel.sku → cache.bySku.
 * Foto-status: een product is "gefotografeerd" als de Shopify-variant een image
 * heeft (variant- of featured-image). Geen match op Shopify = "nieuw".
 *
 * Groepering: per productNr (de fotografeer-eenheid), niet per maat-variant —
 * je fotografeert één product, niet elke maat apart.
 */

import { getPurchaseOrders } from './srs-purchase-orders-client.js';
import { readProductsCache } from './shopify-products-cache.js';
import { readSrsVoorraadRows, readVoorraadRows } from './srs-voorraad-store.js';

const clean = (v) => String(v == null ? '' : v).trim();
const lc = (v) => clean(v).toLowerCase();

/** @param {Object} p  @param {number} [p.days]  inkoop-venster (7–365) */
export async function buildPhotoTodo({ days = 60 } = {}) {
  const safeDays = Math.min(Math.max(Number(days) || 60, 7), 365);

  const [po, cache, srsRows, fallbackRows] = await Promise.all([
    getPurchaseOrders({ days: safeDays }).catch((e) => ({ orders: [], error: e?.message || 'Inkooporders niet beschikbaar.' })),
    readProductsCache().catch(() => null),
    readSrsVoorraadRows().catch(() => []),
    readVoorraadRows().catch(() => [])
  ]);

  const byBarcode = cache?.byBarcode || {};
  const bySku = cache?.bySku || {};

  /* "Ligt al bij de fotograaf" = voorraad op filiaal 701 (Fotoshoot/uitleen).
     701 is een interne SRS-branch die de Shopify-snapshot dropt, dus lees de
     rauwe SRS-voorraad (val terug op rows-latest.json). Keyed op barcode/EAN. */
  const FOTO_FILIAAL = '701';
  const rows701src = (Array.isArray(srsRows) && srsRows.some((r) => String(r.filiaalNummer) === FOTO_FILIAAL)) ? srsRows : fallbackRows;
  const at701 = new Map();
  for (const r of (rows701src || [])) {
    if (String(r.filiaalNummer) !== FOTO_FILIAAL) continue;
    const k = lc(r.sku);
    if (!k) continue;
    at701.set(k, (at701.get(k) || 0) + (Number(r.voorraad) || 0));
  }
  const has701 = at701.size > 0;
  const lookup = (barcode, sku) => {
    const b = lc(barcode);
    const s = lc(sku);
    return (b && byBarcode[b]) || (s && bySku[s]) || null;
  };

  /* Per productNr (fallback barcode/sku) aggregeren. */
  const groups = new Map();
  const groupCodes = new Map(); /* key → Set<lc barcode/sku> voor de 701-match */
  for (const order of (po.orders || [])) {
    const supplier = clean(order.supplier?.name);
    const orderDate = clean(order.orderDate);
    for (const p of (order.products || [])) {
      const key = clean(p.productNr) || clean(p.barcode) || clean(p.sku);
      if (!key) continue;
      let codes = groupCodes.get(key);
      if (!codes) { codes = new Set(); groupCodes.set(key, codes); }
      const bcl = lc(p.barcode); if (bcl) codes.add(bcl);
      const skl = lc(p.sku); if (skl) codes.add(skl);
      let g = groups.get(key);
      if (!g) {
        g = {
          productNr: clean(p.productNr),
          supplier,
          firstOrderDate: orderDate,
          lastOrderDate: orderDate,
          piecesOrdered: 0,
          varianten: 0,
          found: false,
          hasPhoto: false,
          title: '',
          color: '',
          size: '',
          image: '',
          productUrl: '',
          articleNumber: '',
          artikelId: '',
          sampleBarcode: clean(p.barcode) || clean(p.sku)
        };
        groups.set(key, g);
      }
      g.piecesOrdered += Number(p.piecesOrdered || 0);
      g.varianten += 1;
      if (supplier && !g.supplier) g.supplier = supplier;
      if (orderDate) {
        if (!g.firstOrderDate || orderDate < g.firstOrderDate) g.firstOrderDate = orderDate;
        if (!g.lastOrderDate || orderDate > g.lastOrderDate) g.lastOrderDate = orderDate;
      }
      /* Verrijk zodra (en zolang) we nog geen match hadden — een latere maat-
         variant kan wél een barcode hebben die matcht. */
      if (!g.found) {
        const v = lookup(p.barcode, p.sku);
        if (v) {
          g.found = true;
          g.hasPhoto = Boolean(clean(v.image));
          g.title = clean(v.title);
          g.color = clean(v.color);
          g.size = clean(v.size);
          g.image = clean(v.image);
          g.productUrl = clean(v.productUrl);
          g.articleNumber = clean(v.articleNumber);
          g.artikelId = clean(v.srsArtikelId);
        }
      }
    }
  }

  const all = [...groups.entries()].map(([key, g]) => {
    const codes = groupCodes.get(key);
    let bijStuks = 0;
    if (has701 && codes) for (const c of codes) { const n = at701.get(c); if (n) bijStuks += n; }
    return {
      ...g,
      bijFotograaf: bijStuks > 0,
      bijFotograafStuks: bijStuks,
      status: g.hasPhoto ? 'gefotografeerd' : (g.found ? 'teFotograferen' : 'nieuw')
    };
  });

  /* Nieuwste inkoop eerst, dan grootste order. */
  const sortFn = (a, b) =>
    (b.lastOrderDate || '').localeCompare(a.lastOrderDate || '') ||
    (b.piecesOrdered - a.piecesOrdered);

  const teFotograferen = all.filter((g) => g.status === 'teFotograferen').sort(sortFn).slice(0, 500);
  const nieuw = all.filter((g) => g.status === 'nieuw').sort(sortFn).slice(0, 500);
  const gefotografeerd = all.filter((g) => g.status === 'gefotografeerd').sort(sortFn).slice(0, 500);

  return {
    generatedAt: new Date().toISOString(),
    days: safeDays,
    poError: po.error || '',
    poFrom: po.from || '',
    poUntil: po.until || '',
    cacheRefreshedAt: cache?.refreshedAt || null,
    totals: {
      producten: all.length,
      teFotograferen: all.filter((g) => g.status === 'teFotograferen').length,
      nieuw: all.filter((g) => g.status === 'nieuw').length,
      gefotografeerd: all.filter((g) => g.status === 'gefotografeerd').length,
      bijFotograaf: all.filter((g) => g.status === 'teFotograferen' && g.bijFotograaf).length
    },
    teFotograferen,
    nieuw,
    gefotografeerd
  };
}
