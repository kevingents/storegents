/**
 * GET /api/admin/voorraad-sku-diagnose?sku=2900000252042
 *
 * Diagnose voor één SKU: dumpt ALLES wat we erover hebben in de voorraad-blob
 * + de locaties-blob + hoe we het aggregeren in de stock-reconcile. Gebruikt
 * om "waarom toont portal X maar SRS Y" mismatches te debuggen.
 *
 * Response:
 *   {
 *     sku,
 *     voorraadRows:     [{ filiaalNummer, store, voorraad, ideaal, ... }]   uit voorraad_*.csv.gz
 *     locatiesRows:     [{ filiaalNummer, store, locatie, aantal, geblokkeerd }]  uit voorraadlocaties_*.csv.gz
 *     aggregates:       { magazijn, totaal, perFiliaal, locatieAantal }
 *     warehouseConfig:  { branchIds, configured }
 *     meta:             { voorraadGeneratedAt, locatiesGeneratedAt }
 *   }
 */

import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { readVoorraadRows, readLocatiesRows } from '../../lib/srs-voorraad-store.js';
import { listBranchesFromConfig } from '../../lib/business-config.js';

const clean = (v) => String(v == null ? '' : v).trim();
const skuKey = (v) => clean(v).toLowerCase();

export const maxDuration = 30;

/**
 * Live Shopify-call voor 1 specifieke SKU. Returnt ALLE varianten met deze SKU
 * (kan meerdere zijn = duplicaten) en per variant de inventory-breakdown per
 * locatie. Zo zien we direct waar de Shopify-voorraad zit en of het klopt.
 */
async function fetchShopifyVariantsBySku(sku) {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return { configured: false, variants: [], totalInventory: 0 };

  const query = `
    query VariantBySku($q: String!) {
      productVariants(first: 50, query: $q) {
        nodes {
          id
          sku
          title
          inventoryQuantity
          inventoryItem {
            inventoryLevels(first: 50) {
              nodes {
                location { id name }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
          product { id title status handle }
        }
      }
    }`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const resp = await fetch(`https://${shop}/admin/api/${version}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { q: `sku:${sku}` } }),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      return { configured: true, error: `Shopify ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}` };
    }
    const json = await resp.json();
    if (json.errors) {
      return { configured: true, error: `Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}` };
    }
    const variants = (json.data?.productVariants?.nodes || []).map((v) => {
      const idNum = clean(v.id).replace(/^gid:\/\/shopify\/ProductVariant\//, '');
      const productIdNum = clean(v.product?.id).replace(/^gid:\/\/shopify\/Product\//, '');
      const levels = (v.inventoryItem?.inventoryLevels?.nodes || []).map((lvl) => {
        const avail = (lvl.quantities || []).find((q) => q.name === 'available');
        return {
          locationName: clean(lvl.location?.name),
          available: Number(avail?.quantity || 0)
        };
      }).filter((l) => l.available !== 0); /* skip 0-locaties voor leesbaarheid */
      return {
        variantId: idNum,
        productId: productIdNum,
        productTitle: clean(v.product?.title),
        productHandle: clean(v.product?.handle),
        productStatus: clean(v.product?.status),
        sku: clean(v.sku),
        variantTitle: clean(v.title),
        inventoryQuantity: Number(v.inventoryQuantity || 0),
        adminUrl: productIdNum ? `https://${shop}/admin/products/${productIdNum}/variants/${idNum}` : '',
        perLocation: levels
      };
    });
    const totalInventory = variants.reduce((s, v) => s + v.inventoryQuantity, 0);
    return {
      configured: true,
      variants,
      variantCount: variants.length,
      totalInventory,
      duplicate: variants.length > 1
    };
  } catch (error) {
    return { configured: true, error: error?.name === 'AbortError' ? 'Shopify timeout (20s)' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (requireAdmin(req, res)) return;

  const sku = clean(req.query.sku);
  if (!sku) return res.status(400).json({ success: false, message: 'sku query-parameter verplicht.' });

  try {
    const [voorraadRows, locatieRows, shopify] = await Promise.all([
      readVoorraadRows(),
      readLocatiesRows(),
      fetchShopifyVariantsBySku(sku)
    ]);

    const k = skuKey(sku);
    const matchingVoorraad = (voorraadRows || []).filter((r) => skuKey(r.sku) === k);
    const matchingLocaties = (locatieRows || []).filter((r) => skuKey(r.sku) === k);

    /* Aggregeer zoals stock-reconcile dat doet. */
    const branches = listBranchesFromConfig({ includeInternal: true });
    const warehouseIds = new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
    const warehouseBranches = branches.filter((b) => b.kind === 'warehouse').map((b) => ({ branchId: b.branchId, store: b.store }));

    let magazijn = 0;
    let totaal = 0;
    const perFiliaal = {};
    for (const r of matchingVoorraad) {
      const v = Number(r.voorraad || 0);
      totaal += v;
      const fid = String(r.filiaalNummer || '');
      perFiliaal[fid] = perFiliaal[fid] || { store: r.store, voorraad: 0, ideaal: 0, isWarehouse: warehouseIds.has(fid) };
      perFiliaal[fid].voorraad += v;
      perFiliaal[fid].ideaal += Number(r.ideaal || 0);
      if (warehouseIds.has(fid)) magazijn += v;
    }

    /* Locatie-aggregate per filiaal voor cross-check. */
    const locatieAantal = {};
    for (const r of matchingLocaties) {
      const fid = String(r.filiaalNummer || '');
      locatieAantal[fid] = locatieAantal[fid] || { store: r.store, totaal: 0, bakken: 0, geblokkeerd: 0 };
      locatieAantal[fid].totaal += Number(r.aantal || 0);
      locatieAantal[fid].bakken += 1;
      if (r.geblokkeerd) locatieAantal[fid].geblokkeerd += Number(r.aantal || 0);
    }

    /* Verschil-detectie: voor warehouse-filialen, vergelijk voorraad vs locaties. */
    const mismatches = [];
    for (const fid of warehouseIds) {
      const v = perFiliaal[fid]?.voorraad || 0;
      const l = locatieAantal[fid]?.totaal || 0;
      if (v !== l) {
        mismatches.push({
          filiaalNummer: fid,
          store: perFiliaal[fid]?.store || locatieAantal[fid]?.store || `Filiaal ${fid}`,
          voorraadFile: v,
          locatiesFile: l,
          verschil: l - v,
          uitleg: l > v
            ? 'Locaties-bestand telt meer dan voorraad-bestand → voorraad-export laat fysieke bak-aantallen weg (geblokkeerd of niet-doorgezet).'
            : 'Voorraad-bestand telt meer dan locaties → voorraad zonder bak-toewijzing (=valt buiten Shopify-doorzet).'
        });
      }
    }

    /* Cross-check SRS-magazijn vs Shopify-totaal — beschrijf het verschil
       expliciet zodat de admin direct ziet waar het mismatcht. */
    const shopifyTotal = Number(shopify?.totalInventory || 0);
    const srsShopifyDiff = shopifyTotal - magazijn;
    const srsShopifyDiagnose = !shopify?.configured
      ? 'Shopify niet geconfigureerd in env — kan vergelijking niet doen.'
      : shopify?.error
        ? `Shopify-call mislukte: ${shopify.error}`
        : shopify?.duplicate
          ? `${shopify.variantCount} Shopify-varianten met dezelfde SKU — voorraad wordt opgeteld, dat verklaart vaak een verschil.`
          : srsShopifyDiff === 0
            ? 'SRS-magazijn = Shopify-totaal. Klopt.'
            : srsShopifyDiff > 0
              ? `Shopify (${shopifyTotal}) > SRS-magazijn (${magazijn}) — Shopify mogelijk uit-sync (verkoop niet ge-decreased) of voorraad op een verkeerde Shopify-locatie geboekt.`
              : `Shopify (${shopifyTotal}) < SRS-magazijn (${magazijn}) — voorraad in magazijn maar Shopify denkt dat hij op is (sync nog niet gedraaid?).`;

    return res.status(200).json({
      success: true,
      sku,
      voorraadRows: matchingVoorraad,
      locatiesRows: matchingLocaties,
      aggregates: {
        magazijn,
        totaal,
        perFiliaal,
        locatieAantal
      },
      mismatches,
      warehouseConfig: {
        branches: warehouseBranches,
        configured: warehouseIds.size > 0
      },
      counts: {
        voorraadRowsForSku: matchingVoorraad.length,
        locatieRowsForSku: matchingLocaties.length,
        totalVoorraadRows: (voorraadRows || []).length,
        totalLocatieRows: (locatieRows || []).length
      },
      shopify,
      srsVsShopify: {
        srsMagazijn: magazijn,
        shopifyTotal,
        verschil: srsShopifyDiff,
        diagnose: srsShopifyDiagnose
      }
    });
  } catch (error) {
    console.error('[voorraad-sku-diagnose]', error);
    return res.status(500).json({ success: false, message: error.message || 'Diagnose mislukt.' });
  }
}
