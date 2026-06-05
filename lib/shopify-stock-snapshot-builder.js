/**
 * lib/shopify-stock-snapshot-builder.js
 *
 * Bouwt de voorraad-snapshots vanuit SHOPIFY (single source of truth) en
 * schrijft ze naar exact dezelfde blob-paden die de bestaande consumers al
 * lezen:
 *   - srs-stock-snapshot/branch-<branchId>.json   (per-winkel, barcode-key)
 *   - srs-voorraad/rows-latest.json               (alle filialen, sku-key)
 *
 * Hierdoor krijgen ALLE bestaande voorraad-tools (stock-lookup, reserveringen,
 * article-search, voorraad-gezondheid, dashboards, rapport-bouwer, bol-sync)
 * automatisch Shopify-data, zonder dat hun code wijzigt.
 *
 * VOORRAAD komt uit Shopify inventoryLevels (live waarheid). De SRS-only
 * streefwaarde `ideaal` (target stock per filiaal) is GEEN voorraad en wordt
 * gemerged uit de laatste SRS-rows zodat de tekort/overstock-dashboards
 * blijven werken.
 *
 * Mapping Shopify location → branchId loopt via business-config: voor elke
 * bekende branch zoeken we de Shopify location met dezelfde naam.
 */

import { writeBranchSnapshot, bumpSnapshotIndex } from './srs-stock-snapshot-store.js';
import { writeVoorraadSnapshot, readVoorraadRows } from './srs-voorraad-store.js';
import { getLocationsMap } from './shopify-locations.js';
import { listBranchesFromConfig } from './business-config.js';

const clean = (v) => String(v == null ? '' : v).trim();
const norm = (v) => clean(v).toLowerCase();

function shopifyConfig() {
  const shop = clean(process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = clean(process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '');
  const version = clean(process.env.SHOPIFY_API_VERSION || '2025-01');
  if (!shop || !token) throw new Error('Shopify ontbreekt (SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_ACCESS_TOKEN).');
  return { shop, token, version };
}

async function shopifyGraphql(query, variables = {}, { timeoutMs = 30000 } = {}) {
  const cfg = shopifyConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': cfg.token },
      body: JSON.stringify({ query, variables })
    });
    const json = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(`Shopify GraphQL ${resp.status}: ${JSON.stringify(json).slice(0, 200)}`);
    if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 200)}`);
    return json.data;
  } finally { clearTimeout(timer); }
}

/* Numeric location-id uit GID (gid://shopify/Location/12345 → 12345). */
function locNumeric(gidOrId) {
  const s = clean(gidOrId);
  return s.includes('/') ? s.split('/').pop() : s;
}

/* Shopify API 2024-04+ verving InventoryLevel.available door
   quantities(names:["available"]) { name quantity }. Deze helper leest het
   available-getal uit het nieuwe formaat. */
function availableFromLevel(lvl) {
  const qs = lvl?.quantities;
  if (Array.isArray(qs)) {
    const hit = qs.find((q) => clean(q?.name) === 'available');
    return Number(hit?.quantity || 0);
  }
  /* Fallback voor oudere API-versies. */
  return Number(lvl?.available || 0);
}

/**
 * Bouw mapping locationId(numeric) → { branchId, store } op basis van
 * naam-match tussen business-config branches en Shopify locations.
 */
async function buildLocationToBranchMap() {
  const [locMap, branches] = await Promise.all([
    getLocationsMap(),
    Promise.resolve(listBranchesFromConfig({ includeInternal: true }))
  ]);
  /* locName(lower) → location numeric id */
  const byName = new Map();
  for (const loc of locMap.values()) {
    if (loc?.name) byName.set(norm(loc.name), { id: locNumeric(loc.id), name: loc.name });
  }
  const result = new Map(); /* numericLocationId → { branchId, store } */
  const matched = [];
  const unmatched = [];
  for (const b of branches) {
    const hit = byName.get(norm(b.store));
    if (hit) {
      result.set(hit.id, { branchId: String(b.branchId), store: b.store, kind: b.kind });
      matched.push({ branchId: b.branchId, store: b.store, locationId: hit.id });
    } else {
      unmatched.push({ branchId: b.branchId, store: b.store });
    }
  }
  return { map: result, matched, unmatched };
}

/**
 * Itereer alle Shopify productVariants + inventoryLevels via cursor-paginatie.
 * Roept onVariant({ sku, barcode, title, product, levels: [{available, locationId}] })
 * voor elke variant aan.
 */
async function forEachVariantInventory(onVariant, { pageSize = 200, maxPages = 60 } = {}) {
  let cursor = null;
  let page = 0;
  for (;;) {
    page += 1;
    if (page > maxPages) {
      console.warn(`[shopify-stock-snapshot] maxPages (${maxPages}) bereikt — stop paginatie.`);
      break;
    }
    const q = `query VariantInv($n: Int!, $after: String) {
      productVariants(first: $n, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          sku barcode title
          product { title }
          inventoryItem {
            inventoryLevels(first: 25) {
              nodes { quantities(names: ["available"]) { name quantity } location { id } }
            }
          }
        }
      }
    }`;
    const data = await shopifyGraphql(q, { n: pageSize, after: cursor });
    const conn = data?.productVariants;
    const nodes = conn?.nodes || [];
    for (const v of nodes) {
      const levels = (v.inventoryItem?.inventoryLevels?.nodes || []).map((lvl) => ({
        available: availableFromLevel(lvl),
        locationId: locNumeric(lvl.location?.id)
      }));
      onVariant({
        sku: clean(v.sku),
        barcode: clean(v.barcode),
        title: clean(v.product?.title || v.title),
        levels
      });
    }
    if (!conn?.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return page;
}

/**
 * Hoofd-builder. Haalt alle Shopify-voorraad op en schrijft:
 *   - per branch: branch-snapshot (barcode-rows)
 *   - globaal: voorraad-rows (sku per filiaal, met ideaal-merge uit SRS)
 *
 * @returns {Promise<{ ok, branches, variantsSeen, rowsWritten, unmatched, idealMerged }>}
 */
export async function buildShopifyStockSnapshots() {
  const { map: locToBranch, matched, unmatched } = await buildLocationToBranchMap();
  if (!matched.length) {
    return { ok: false, reason: 'Geen Shopify-locations matchen business-config branch-namen.', unmatched };
  }

  /* Per-branch barcode-rows: branchId → Map<barcode, {barcode, sku, pieces, title}> */
  const branchRows = new Map();
  /* Per-branch sku-voorraad: branchId → Map<skuNorm, {sku, pieces}>
     (skuNorm als key voor dedup, originele sku-casing bewaard voor output). */
  const branchSkuStock = new Map();
  const ensureBranch = (branchId) => {
    if (!branchRows.has(branchId)) branchRows.set(branchId, new Map());
    if (!branchSkuStock.has(branchId)) branchSkuStock.set(branchId, new Map());
  };

  let variantsSeen = 0;
  await forEachVariantInventory((v) => {
    variantsSeen += 1;
    if (!v.levels.length) return;
    for (const lvl of v.levels) {
      const branch = locToBranch.get(lvl.locationId);
      if (!branch) continue; /* location niet gemapped op een branch */
      ensureBranch(branch.branchId);
      /* Barcode-row (branch-snapshot). Som als zelfde barcode meerdere keren. */
      if (v.barcode) {
        const m = branchRows.get(branch.branchId);
        const prev = m.get(v.barcode);
        m.set(v.barcode, {
          barcode: v.barcode,
          sku: v.sku || prev?.sku || v.barcode,
          pieces: (prev?.pieces || 0) + lvl.available,
          title: v.title || prev?.title || '',
          updatedAt: new Date().toISOString()
        });
      }
      /* Sku-voorraad (voorraad-rows). Bewaar originele casing. */
      if (v.sku) {
        const sm = branchSkuStock.get(branch.branchId);
        const k = norm(v.sku);
        const prev = sm.get(k);
        sm.set(k, { sku: prev?.sku || v.sku, pieces: (prev?.pieces || 0) + lvl.available });
      }
    }
  });

  /* Schrijf per branch de snapshot (barcode-rows). */
  let rowsWritten = 0;
  const writtenBranchIds = [];
  for (const [branchId, rowMap] of branchRows.entries()) {
    const rows = Array.from(rowMap.values());
    await writeBranchSnapshot(branchId, rows);
    rowsWritten += rows.length;
    writtenBranchIds.push(branchId);
  }
  await bumpSnapshotIndex({ branchIds: writtenBranchIds, mode: 'full', fileCount: writtenBranchIds.length, rowCount: rowsWritten });

  /* ── Voorraad-rows (sku per filiaal) met ideaal-merge uit SRS. ──────────
     `ideaal` (target) is een SRS-streefwaarde, geen voorraad. Behoud die uit
     de laatste SRS-rows zodat tekort/overstock-dashboards blijven werken. */
  const idealByKey = new Map(); /* `${filiaal}::${skuNorm}` → ideaal */
  let idealMerged = 0;
  try {
    const srsRows = await readVoorraadRows();
    for (const r of (srsRows || [])) {
      const key = `${String(r.filiaalNummer)}::${norm(r.sku)}`;
      if (Number(r.ideaal) > 0) { idealByKey.set(key, Number(r.ideaal)); idealMerged += 1; }
    }
  } catch (e) {
    console.warn('[shopify-stock-snapshot] ideaal-merge uit SRS faalde:', e.message);
  }

  const branchMeta = new Map(matched.map((m) => [String(m.branchId), m.store]));
  const voorraadRows = [];
  for (const [branchId, skuMap] of branchSkuStock.entries()) {
    const store = branchMeta.get(branchId) || `Filiaal ${branchId}`;
    for (const [skuNorm, entry] of skuMap.entries()) {
      const ideaal = idealByKey.get(`${branchId}::${skuNorm}`) || 0;
      const voorraad = Math.round(entry.pieces);
      voorraadRows.push({
        filiaalNummer: branchId,
        store,
        sku: entry.sku,
        voorraad,
        ideaal,
        tekort: Math.max(0, ideaal - voorraad)
      });
    }
  }
  await writeVoorraadSnapshot(voorraadRows, { sourceFile: 'shopify-live', bron: 'shopify' });

  return {
    ok: true,
    bron: 'shopify',
    branches: writtenBranchIds.length,
    variantsSeen,
    rowsWritten,
    voorraadRows: voorraadRows.length,
    idealMerged,
    unmatched
  };
}
