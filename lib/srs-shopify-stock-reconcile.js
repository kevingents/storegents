/**
 * lib/srs-shopify-stock-reconcile.js
 *
 * Reconcile van de SRS-voorraad (wat we doorzetten) met de Shopify-voorraad.
 * Beantwoordt: "klopt de voorraad die we vanaf SRS doorzetten met Shopify, en
 * staan er artikelen in het SRS-bestand die niet (goed) in Shopify staan?"
 *
 * Basis: de webshop verkoopt uit het MAGAZIJN, dus we vergelijken Shopify-
 * voorraad per SKU met de SRS-magazijn-voorraad (kind=warehouse). De SRS-
 * totaalvoorraad (alle filialen) wordt erbij getoond voor context.
 *
 * Buckets:
 *   nietInShopify       — SKU met magazijn-voorraad>0 maar geen Shopify-variant
 *   voorraadVerschil    — SKU in beide, Shopify-voorraad ≠ SRS-magazijn-voorraad
 *   inShopifyNietInSrs  — Shopify-variant met voorraad>0 maar SKU niet in SRS
 *
 * Read-only: schrijft niets naar Shopify of SRS. Resultaat wordt gecached.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { readVoorraadRows, readLocatiesRows } from './srs-voorraad-store.js';
import { listBranchesFromConfig } from './business-config.js';
import { getVoorraadBasisConfig, basisForProductType } from './voorraad-basis-config.js';

const RECON_PATH = 'shopify-products/stock-reconcile.json';
const MAX_AGE_MS = Number(process.env.SHOPIFY_STOCK_RECON_MAX_AGE_MS || 6 * 60 * 60 * 1000);
const MAX_PER_BUCKET = 2000;

function getConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

const clean = (v) => String(v == null ? '' : v).trim();
const skuKey = (v) => clean(v).toLowerCase();

const RECON_QUERY = `
  query StockRecon($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        productType
        variants(first: 100) {
          nodes { sku inventoryQuantity }
        }
      }
    }
  }`;

/** Haal per SKU de Shopify-voorraad op (som over varianten met dezelfde SKU). */
async function fetchShopifyInventoryBySku(cfg) {
  const bySku = new Map();
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 500;
  while (pages < MAX_PAGES) {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: RECON_QUERY, variables: { cursor } })
    });
    if (!resp.ok) throw new Error(`Shopify GraphQL ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    const json = await resp.json();
    if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
    const conn = json.data?.products;
    if (!conn) break;
    for (const p of (conn.nodes || [])) {
      const idNum = clean(p.id).replace(/^gid:\/\/shopify\/Product\//, '');
      const productType = clean(p.productType);
      for (const v of (p.variants?.nodes || [])) {
        const k = skuKey(v.sku);
        if (!k) continue;
        const inv = Number(v.inventoryQuantity || 0);
        const cur = bySku.get(k) || { sku: clean(v.sku), inventory: 0, productTitle: clean(p.title), productId: idNum, status: clean(p.status), handle: clean(p.handle), productType };
        cur.inventory += inv;
        /* Eerste hit wint qua productType. Bij duplicate SKU's over verschillende
           producten is dat nooit perfect, maar gegeven dat duplicate-SKU's an sich
           al een probleem zijn aanvaardbaar. */
        if (!cur.productType && productType) cur.productType = productType;
        bySku.set(k, cur);
      }
    }
    pages += 1;
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { bySku, pages };
}

/** Aggregeer SRS-voorraad per SKU, gesplitst naar magazijn (warehouse) en totaal. */
function aggregateSrsBySku(rows) {
  const branches = listBranchesFromConfig({ includeInternal: true });
  const warehouseIds = new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
  const bySku = new Map();
  for (const r of (rows || [])) {
    const k = skuKey(r.sku);
    if (!k) continue;
    const cur = bySku.get(k) || { sku: clean(r.sku), magazijn: 0, totaal: 0 };
    const v = Number(r.voorraad || 0);
    cur.totaal += v;
    if (warehouseIds.has(String(r.filiaalNummer))) cur.magazijn += v;
    bySku.set(k, cur);
  }
  return { bySku, warehouseConfigured: warehouseIds.size > 0 };
}

/**
 * Voer de reconcile uit (live Shopify-scan + SRS-voorraad-snapshot).
 * @returns {Promise<object>}
 */
export async function runStockReconcile() {
  const cfg = getConfig();
  if (!cfg) throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt.');

  const [{ bySku: shop, pages }, voorraadRows, locatieRows, basisCfg] = await Promise.all([
    fetchShopifyInventoryBySku(cfg),
    readVoorraadRows(),
    readLocatiesRows(),
    getVoorraadBasisConfig()
  ]);
  const { bySku: srs, warehouseConfigured } = aggregateSrsBySku(voorraadRows);

  /* Bouw locaties-per-SKU map (alleen warehouse-filialen). Zo kunnen we voor de
     "Wel Shopify, niet SRS"-bucket per SKU laten zien: ligt het wel ergens in
     het magazijn (in een bak) maar is het uit de voorraad-export gevallen? Dat
     is een hele typische oorzaak — zonder locatie wordt het niet doorgezet. */
  const branches = listBranchesFromConfig({ includeInternal: true });
  const warehouseIds = new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
  const locBySku = new Map();
  for (const r of (locatieRows || [])) {
    const k = skuKey(r.sku);
    if (!k) continue;
    if (warehouseIds.size > 0 && !warehouseIds.has(String(r.filiaalNummer))) continue;
    const arr = locBySku.get(k) || [];
    arr.push({
      filiaal: clean(r.store) || String(r.filiaalNummer || ''),
      locatie: clean(r.locatie),
      aantal: Number(r.aantal || 0),
      geblokkeerd: Boolean(r.geblokkeerd)
    });
    locBySku.set(k, arr);
  }
  /* Geen warehouse-config → val terug op totaal als vergelijkingsbasis. */
  const srsBasis = (row) => (warehouseConfigured ? row.magazijn : row.totaal);

  const BUCKET_KEYS = ['nietInShopify', 'voorraadVerschil', 'inShopifyNietInSrs'];
  const buckets = Object.fromEntries(BUCKET_KEYS.map((k) => [k, []]));
  const bucketCounts = Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0]));
  const add = (key, item) => { bucketCounts[key] += 1; if (buckets[key].length < MAX_PER_BUCKET) buckets[key].push(item); };

  /* Globale totalen voor de top-of-page health-check. Bereken parallel met
     de bucket-loop zodat we 1× door de data heen gaan. */
  let srsSkusMetVoorraad = 0;
  let srsTotalStuks = 0;          /* som van SRS-totaal over alle SKU's (alle filialen) */
  let srsMagazijnStuks = 0;       /* som van SRS-magazijn over alle SKU's */
  let srsBasisStuks = 0;          /* som van de per-SKU gekozen basis (vergelijkbaar met shopify) */
  let shopifyInBeideStuks = 0;    /* som van Shopify-voorraad alleen voor SKU's die ook in SRS zitten */
  let skusBasisMagazijn = 0;      /* hoeveel SKU's krijgen basis=magazijn (pakken etc) */
  let skusBasisTotaal = 0;        /* hoeveel SKU's krijgen basis=totaal (schoenen etc) */
  for (const [k, row] of srs.entries()) {
    const sh = shop.get(k);
    const { value: basisValue, field: basisField } = srsBasis(row, sh?.productType);
    if (basisValue > 0) srsSkusMetVoorraad += 1;
    srsTotalStuks += Number(row.totaal || 0);
    srsMagazijnStuks += Number(row.magazijn || 0);
    srsBasisStuks += Number(basisValue || 0);
    if (sh) shopifyInBeideStuks += Number(sh.inventory || 0);
    if (basisField === 'magazijn') skusBasisMagazijn += 1; else skusBasisTotaal += 1;
    if (!sh) {
      /* In SRS-basis (magazijn of totaal) maar geen Shopify-variant met die SKU. */
      if (basisValue > 0) add('nietInShopify', { sku: row.sku, srsMagazijn: row.magazijn, srsTotaal: row.totaal });
      continue;
    }
    if (sh.inventory !== basisValue) {
      add('voorraadVerschil', {
        sku: row.sku,
        srsMagazijn: row.magazijn,
        srsTotaal: row.totaal,
        srsBasis: basisValue,       /* welk getal we vergeleken hebben */
        srsBasisField: basisField,  /* 'magazijn' of 'totaal' */
        shopify: sh.inventory,
        verschil: sh.inventory - basisValue,
        productType: sh.productType || '',
        productTitle: sh.productTitle,
        status: sh.status,
        adminUrl: sh.productId ? `https://${cfg.shop}/admin/products/${sh.productId}` : ''
      });
    }
  }
  /* Shopify-totaal (over alle SKU's, ook die NIET in SRS zitten). */
  let shopifyTotalStuks = 0;
  let shopifyTotalSkusMetVoorraad = 0;
  for (const sh of shop.values()) {
    if (Number(sh.inventory || 0) > 0) shopifyTotalSkusMetVoorraad += 1;
    shopifyTotalStuks += Number(sh.inventory || 0);
  }

  for (const [k, sh] of shop.entries()) {
    if (sh.inventory <= 0) continue;
    if (!srs.has(k)) {
      /* Locatie-info erbij: ligt het wel in magazijn (=verklaart waarom 't uit
         de voorraad-export viel) of écht nergens (=actie nodig). */
      const locaties = locBySku.get(k) || [];
      const magazijnAantal = locaties.reduce((s, l) => s + (Number(l.aantal) || 0), 0);
      add('inShopifyNietInSrs', {
        sku: sh.sku, shopify: sh.inventory, productTitle: sh.productTitle, status: sh.status,
        adminUrl: sh.productId ? `https://${cfg.shop}/admin/products/${sh.productId}` : '',
        /* Verrijking voor diagnose: */
        hasMagazijnLocatie: locaties.length > 0,
        magazijnAantal,
        magazijnGeblokkeerd: locaties.some((l) => l.geblokkeerd),
        /* Top 3 bakken — de UI laat er max 1-2 zien, csv-export pakt alles. */
        magazijnLocaties: locaties.slice(0, 3).map((l) => `${l.locatie}${l.aantal ? ` (${l.aantal})` : ''}${l.geblokkeerd ? ' ⚠' : ''}`).join(', ')
      });
    }
  }

  /* Sorteer de verschil-lijst op grootste afwijking. */
  buckets.voorraadVerschil.sort((a, b) => Math.abs(b.verschil) - Math.abs(a.verschil));

  /* Gezondheids-score per basis-keuze. Voor de vergelijkbare-SKU's (in beide) is
     het verschil van shopify-in-beide vs srs-basis-stuks de echte mismatch. */
  const compareDiff = shopifyInBeideStuks - srsBasisStuks;
  const compareDiffPct = srsBasisStuks > 0 ? Math.round((compareDiff / srsBasisStuks) * 1000) / 10 : null;

  const result = {
    refreshedAt: new Date().toISOString(),
    pages,
    basis: warehouseConfigured ? 'per-categorie' : 'totaal',
    basisDefault: basisCfg?.defaultBasis || 'magazijn',
    basisHasOverride: Boolean(basisCfg?.hasOverride),
    warehouseConfigured,
    counts: {
      shopifySkus: shop.size,
      shopifySkusMetVoorraad: shopifyTotalSkusMetVoorraad,
      srsSkus: srs.size,
      srsSkusMetVoorraad,
      skusBasisMagazijn,
      skusBasisTotaal
    },
    /* Inventory-totalen voor sanity-check bovenaan de pagina. */
    inventoryTotals: {
      srsTotal: srsTotalStuks,
      srsMagazijn: srsMagazijnStuks,
      srsBasis: srsBasisStuks,
      shopifyTotal: shopifyTotalStuks,
      shopifyInBeide: shopifyInBeideStuks,
      compareDiff,        /* shopify-in-beide vs srs-basis (van vergelijkbare SKU's) */
      compareDiffPct
    },
    bucketCounts,
    truncated: BUCKET_KEYS.some((key) => bucketCounts[key] > MAX_PER_BUCKET),
    buckets
  };

  try { await writeJsonBlob(RECON_PATH, result); } catch (e) { /* cache optioneel */ }
  return result;
}

export async function readStockReconcile() {
  return readJsonBlob(RECON_PATH, null);
}

export function isReconFresh(recon) {
  if (!recon?.refreshedAt) return false;
  return (Date.now() - new Date(recon.refreshedAt).getTime()) < MAX_AGE_MS;
}
