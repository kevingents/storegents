/**
 * GET /api/reserveringen/products?store=GENTS+Tilburg&q=zoekterm
 *
 * Zoek artikelen die de winkel ZELF in voorraad heeft (= mogen gereserveerd
 * worden). Combineert Shopify product-search met de winkel-voorraad-snapshot
 * uit SRS (lib/srs-stock-snapshot-store).
 *
 * Strikt: alleen items met voorraad ≥ 1 in de meldende winkel komen terug.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getReserveringBranch } from '../../lib/reserveringen-branch-mapping.js';

const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2024-10';

function cleanShop(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
}

function clean(value) { return String(value || '').trim(); }

async function fetchShopifyVariants(query) {
  const shop = cleanShop(process.env.SHOPIFY_STORE_URL);
  const token = process.env.SHOPIFY_ACCESS_TOKEN;
  if (!shop || !token || !query) return [];

  const q = String(query).trim();
  /* Build Shopify search: title, sku, barcode */
  const searchQuery = /^\d{8,}$/.test(q)
    ? `barcode:${q} OR sku:${q}` /* puur numeriek → likely barcode */
    : `title:*${q}* OR sku:${q} OR barcode:${q}`;

  const graphQuery = `
    query SearchVariants($q: String!) {
      productVariants(first: 30, query: $q) {
        edges {
          node {
            id
            sku
            barcode
            title
            displayName
            price
            image { url }
            inventoryQuantity
            selectedOptions { name value }
            product {
              title
              featuredImage { url }
              vendor
            }
          }
        }
      }
    }
  `;

  try {
    const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: graphQuery, variables: { q: searchQuery } })
    });
    const data = await response.json();
    return (data?.data?.productVariants?.edges || []).map((edge) => {
      const v = edge.node;
      const opts = (v.selectedOptions || []).reduce((acc, o) => { acc[String(o.name || '').toLowerCase()] = o.value; return acc; }, {});
      return {
        variantId: String(v.id || '').split('/').pop(),
        sku: v.sku || '',
        barcode: v.barcode || '',
        title: v.product?.title || v.displayName || '',
        variantTitle: v.title || '',
        size: opts.maat || opts.size || '',
        color: opts.kleur || opts.color || opts.colour || '',
        price: Number(v.price || 0),
        image: v.image?.url || v.product?.featuredImage?.url || '',
        vendor: v.product?.vendor || ''
      };
    });
  } catch (error) {
    console.warn('[reserveringen/products] Shopify search failed:', error.message);
    return [];
  }
}

/**
 * Haal voorraad op via de SRS stock-snapshot per branch (SFTP-cron).
 */
async function getStoreStock(branchId) {
  if (!branchId) return new Map();
  try {
    const mod = await import('../../lib/srs-stock-snapshot-store.js');
    const fn = mod.readBranchSnapshot || mod.getBranchSnapshotFresh;
    if (typeof fn !== 'function') return new Map();
    const snap = await fn(String(branchId));
    const rows = Array.isArray(snap?.rows) ? snap.rows : Array.isArray(snap?.items) ? snap.items : [];
    const map = new Map();
    for (const item of rows) {
      const barcode = String(item.barcode || item.sku || '').trim().toLowerCase();
      const sku = String(item.sku || '').trim().toLowerCase();
      const qty = Number(item.quantity ?? item.pieces ?? item.voorraad ?? 0);
      if (barcode) map.set(barcode, qty);
      if (sku && sku !== barcode) map.set(sku, qty);
    }
    return map;
  } catch (error) {
    console.warn('[reserveringen/products] stock-snapshot failed:', error.message);
    return new Map();
  }
}

async function getBranchIdForStore(store) {
  try {
    const mod = await import('../../lib/branch-metrics.js');
    if (typeof mod.listBranches === 'function') {
      const branches = mod.listBranches() || [];
      const match = branches.find((b) => String(b.store || '').trim().toLowerCase() === String(store).trim().toLowerCase());
      return match?.branchId || '';
    }
  } catch { /* fall through */ }
  return '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const store = clean(req.query.store);
    const query = clean(req.query.q || req.query.query);
    if (!store) return res.status(400).json({ success: false, message: 'Geef ?store=... mee.' });
    if (!query || query.length < 2) {
      return res.status(200).json({ success: true, items: [], note: 'Typ minimaal 2 tekens.' });
    }

    const resBranch = getReserveringBranch(store);
    if (!resBranch) {
      return res.status(400).json({
        success: false,
        message: `Voor "${store}" is geen RES-filiaal geconfigureerd. Vraag admin om de branch-mapping aan te vullen.`
      });
    }

    const branchId = await getBranchIdForStore(store);
    const [variants, stockMap] = await Promise.all([
      fetchShopifyVariants(query),
      getStoreStock(branchId)
    ]);

    /* Filter: alleen items met voorraad ≥ 1 in winkel */
    const items = variants.map((v) => {
      const lookupBarcode = v.barcode.toLowerCase();
      const lookupSku = v.sku.toLowerCase();
      const stock = stockMap.get(lookupBarcode) ?? stockMap.get(lookupSku) ?? 0;
      return { ...v, stockInStore: stock };
    }).filter((v) => v.stockInStore > 0);

    return res.status(200).json({
      success: true,
      store,
      resBranch,
      stockSource: stockMap.size > 0 ? 'srs_snapshot' : 'none',
      stockSnapshotItems: stockMap.size,
      items,
      message: items.length === 0
        ? `Geen resultaten met voorraad in ${store}. ${stockMap.size === 0 ? 'Voorraad-snapshot ontbreekt — wacht op SFTP-cron of vraag admin.' : 'Probeer een andere zoekterm.'}`
        : ''
    });
  } catch (error) {
    console.error('[reserveringen/products]', error);
    return res.status(500).json({ success: false, message: error.message || 'Producten konden niet worden opgehaald.' });
  }
}
