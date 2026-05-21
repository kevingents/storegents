/**
 * Realtime Shopify product-search via GraphQL Admin API.
 *
 * Vervangt de cache-based article-search voor naam-zoekopdrachten. Per
 * zoekopdracht 1 GraphQL call met:
 *   - product-search (Shopify's eigen search syntax)
 *   - variants + SRSERP metafields
 *   - inventory levels per location (= filiaal voorraad)
 *
 * Voordelen vs cache:
 *   - Altijd actuele voorraad (geen daily-cron-vertraging)
 *   - Altijd actuele product-data (titels, foto's)
 *   - Geen cron failures meer
 *
 * Trade-offs:
 *   - ~200-500ms latency per zoek (Shopify API call)
 *   - Cost rate-limits bij piekgebruik (mitigeer met memory-cache per query)
 *
 * Locations: Shopify Location GID → GENTS store-naam via env-var
 *   SHOPIFY_LOCATIONS_MAP_JSON = {"gid://shopify/Location/12345":"GENTS Arnhem", ...}
 * Of: gebruikt Shopify Location.name direct als die matched met store-naam.
 */

const SRS_METAFIELD_NAMESPACE = process.env.SHOPIFY_SRS_METAFIELD_NS || 'SRSERP';
const SEARCH_TIMEOUT_MS = Number(process.env.SHOPIFY_SEARCH_TIMEOUT_MS || 12000);

/* In-memory cache per (queryString) — voorkomt dat dezelfde zoekopdracht in
   korte tijd meerdere Shopify-calls afvuurt (bv. typeahead-debounce of meerdere
   medewerkers die hetzelfde zoeken). TTL: 60 seconden. */
const __MEM_CACHE__ = new Map();
const MEM_TTL_MS = 60_000;

function clean(v) { return String(v == null ? '' : v).trim(); }
function lower(v) { return clean(v).toLowerCase(); }
function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

function getConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) {
    throw new Error('SHOPIFY_STORE_DOMAIN + SHOPIFY_ADMIN_ACCESS_TOKEN moeten in Vercel env staan voor realtime search.');
  }
  return { shop, token, version };
}

/* Mapping Shopify Location → GENTS store-naam. Eerst kijken naar
   SHOPIFY_LOCATIONS_MAP_JSON, anders fallback op location.name. */
function getLocationsMap() {
  const raw = process.env.SHOPIFY_LOCATIONS_MAP_JSON || '';
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

function locationToStoreName(loc) {
  if (!loc) return '';
  const map = getLocationsMap();
  if (map[loc.id]) return map[loc.id];
  /* Strip "GENTS" prefix-mismatch tolerance — location.name kan zijn "Arnhem"
     of "GENTS Arnhem". Beide werkt zolang het herkenbaar is. */
  return clean(loc.name);
}

function detectColorSize(selectedOptions) {
  let color = '', size = '';
  for (const opt of (selectedOptions || [])) {
    const name = String(opt.name || '').toLowerCase();
    const val = clean(opt.value);
    if (!val) continue;
    if (name.includes('kleur') || name.includes('color') || name.includes('colour')) color = val;
    else if (name.includes('maat') || name.includes('size')) size = val;
  }
  if (!color || !size) {
    const opts = (selectedOptions || []).map((o) => clean(o.value));
    if (!color && opts[0] && !/^\d+$/.test(opts[0])) color = opts[0];
    if (!size && opts[1] && /^[\dXSML/]+$/i.test(opts[1])) size = opts[1];
  }
  return { color, size };
}

function metafieldsToObject(edges) {
  const out = {};
  for (const e of (edges || [])) {
    const n = e?.node;
    if (!n) continue;
    out[n.key] = clean(n.value);
  }
  return out;
}

/**
 * Bouw de Shopify search-query string op basis van wat de user typed.
 * Shopify search syntax: https://shopify.dev/docs/api/usage/search-syntax
 *
 * Voorbeelden:
 *   "rokjas"       → title:*rokjas* OR vendor:*rokjas*
 *   "00002018"     → sku:00002018* OR barcode:00002018
 *   "8721157458033"→ barcode:8721157458033
 *   "pak blauw"    → title:*pak* AND title:*blauw*
 */
function buildShopifyQuery(q) {
  const v = clean(q);
  if (!v) return '';
  /* Pure digits */
  if (/^\d+$/.test(v)) {
    const stripped = v.replace(/^0+(?=\d)/, '');
    if (stripped.length >= 8) {
      /* Barcode-lengte: zoek alleen op barcode */
      return `barcode:${v}`;
    }
    /* Korte numeriek = artikelcode → match in SKU (Shopify SKU bevat vaak code) */
    return `sku:${v}* OR sku:${stripped}*`;
  }
  /* Heeft spaties → multi-word title search */
  if (/\s/.test(v)) {
    return v.split(/\s+/).filter(Boolean).map((w) => `title:*${w}*`).join(' AND ');
  }
  /* SKU-stijl identifier (cijfers + letters of separators) */
  if (/[._\\/-]/.test(v) || /\d/.test(v)) {
    return `(sku:*${v}* OR title:*${v}*)`;
  }
  /* Pure letters → name search in titel + vendor */
  return `(title:*${v}* OR vendor:*${v}*)`;
}

/* Twee queries om onder de Shopify GraphQL 1000-cost-limit te blijven:
   Query 1: products + variants metadata (NIET inventory).
   Query 2: batch-fetch inventory levels voor gevonden variant-IDs via nodes(). */
const PRODUCT_SEARCH_QUERY = `
  query ProductSearch($q: String!, $first: Int!) {
    products(first: $first, query: $q) {
      edges {
        node {
          id
          title
          handle
          vendor
          productType
          featuredImage { url }
          descriptionHtml
          metafields(first: 8, namespace: "${SRS_METAFIELD_NAMESPACE}") {
            edges { node { key value } }
          }
          variants(first: 20) {
            edges {
              node {
                id
                sku
                barcode
                title
                price
                selectedOptions { name value }
              }
            }
          }
        }
      }
    }
  }
`;

const INVENTORY_BATCH_QUERY = `
  query InventoryBatch($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        inventoryItem {
          inventoryLevels(first: 25) {
            edges {
              node {
                quantities(names: ["available"]) { quantity }
                location { id name }
              }
            }
          }
        }
      }
    }
  }
`;

async function callShopifyGraphQL(query, variables) {
  const cfg = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': cfg.token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Shopify GraphQL ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = await resp.json();
    if (json.errors) {
      throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Doe een realtime search en map naar de response-shape die article-search
 * frontend verwacht: array van { articleNumber, sku, barcode, title, color,
 * size, image, branches[], totalPieces, branchCount, vendor, ... }.
 *
 * @param {object} input
 * @param {string} input.q — zoekterm
 * @param {string} [input.ownStore] — naam huidige winkel voor isOwn-markering
 * @param {number} [input.limit=30] — max producten retourneren
 */
export async function realtimeSearch({ q, ownStore = '', limit = 30 } = {}) {
  const query = clean(q);
  if (!query) return { results: [], totalMatched: 0, cached: false };

  const shopifyQuery = buildShopifyQuery(query);
  if (!shopifyQuery) return { results: [], totalMatched: 0, cached: false };

  /* Memory-cache check */
  const cacheKey = `${shopifyQuery}::${limit}`;
  const cached = __MEM_CACHE__.get(cacheKey);
  if (cached && (Date.now() - cached.at) < MEM_TTL_MS) {
    /* Hergebruik resultaten maar her-bereken isOwn want ownStore kan verschillen */
    return {
      ...cached.data,
      results: cached.data.results.map((r) => ({
        ...r,
        branches: r.branches.map((b) => ({ ...b, isOwn: ownStore && b.store === ownStore }))
      })),
      cached: true,
      cachedAt: cached.at
    };
  }

  /* Step 1: search products + variants metadata (NO inventory yet) */
  const data = await callShopifyGraphQL(PRODUCT_SEARCH_QUERY, { q: shopifyQuery, first: limit });
  const products = (data?.products?.edges || []).map((e) => e.node);

  /* Bouw flat list van variant-rows — eerst zonder branches */
  const results = [];
  const variantIdToResult = new Map();
  for (const product of products) {
    const productMetafields = metafieldsToObject(product?.metafields?.edges);
    const description = stripHtml(product?.descriptionHtml || '').slice(0, 500);
    const featuredImage = clean(product?.featuredImage?.url) || '';
    const productHandle = clean(product?.handle);

    const srsArtikelId = productMetafields['artikel_id'] || productMetafields['artikelId'] || '';
    const srsRveArtikelnummer = productMetafields['rve_artikelnummer'] || productMetafields['rveArtikelnummer'] || '';
    const subgroep = productMetafields['subgroep'] || '';
    const hoofdgroep = productMetafields['hoofdgroep'] || '';
    const hoofdgroepOmschrijving = productMetafields['hoofdgroep_omschrijving'] || productMetafields['hoofdgroepOmschrijving'] || '';

    for (const vEdge of (product?.variants?.edges || [])) {
      const variant = vEdge?.node;
      if (!variant) continue;
      const { color, size } = detectColorSize(variant.selectedOptions);
      const sku = clean(variant.sku);
      const barcode = clean(variant.barcode);
      const articleNumber = srsRveArtikelnummer || srsArtikelId || sku || barcode;

      const result = {
        variantId: clean(variant.id),
        articleNumber: clean(articleNumber),
        barcode,
        sku: sku || barcode,
        title: clean(product?.title || ''),
        descriptionPlain: description,
        description: description,
        color,
        size,
        image: featuredImage,
        images: featuredImage ? [featuredImage] : [],
        productUrl: productHandle ? `https://${getConfig().shop}/products/${productHandle}` : '',
        vendor: clean(product?.vendor || ''),
        productType: clean(product?.productType || ''),
        price: clean(variant?.price || ''),
        srsArtikelId,
        srsRveArtikelnummer,
        subgroep,
        hoofdgroep,
        hoofdgroepOmschrijving,
        totalPieces: 0,
        branchCount: 0,
        branches: []
      };
      results.push(result);
      if (variant.id) variantIdToResult.set(variant.id, result);
    }
  }

  /* Step 2: batch-fetch inventory voor alle variant-IDs.
     Chunks van 50 om onder de 1000-cost te blijven (50 × ~15 = 750). */
  const variantIds = Array.from(variantIdToResult.keys());
  const CHUNK_SIZE = 50;
  for (let i = 0; i < variantIds.length; i += CHUNK_SIZE) {
    const chunk = variantIds.slice(i, i + CHUNK_SIZE);
    try {
      const invData = await callShopifyGraphQL(INVENTORY_BATCH_QUERY, { ids: chunk });
      const nodes = invData?.nodes || [];
      for (const node of nodes) {
        if (!node?.id) continue;
        const result = variantIdToResult.get(node.id);
        if (!result) continue;
        const branches = [];
        let totalPieces = 0;
        let branchCount = 0;
        for (const lvlEdge of (node?.inventoryItem?.inventoryLevels?.edges || [])) {
          const lvl = lvlEdge?.node;
          if (!lvl) continue;
          const storeName = locationToStoreName(lvl.location);
          if (!storeName) continue;
          const available = Number((lvl.quantities || []).find((qx) => qx.name === 'available')?.quantity ?? 0);
          if (available > 0) branchCount += 1;
          totalPieces += Math.max(0, available);
          branches.push({
            branchId: clean(lvl.location?.id || ''),
            store: storeName,
            pieces: Math.max(0, available),
            isOwn: ownStore && storeName === ownStore,
            type: /magazijn|warehouse|dc/i.test(storeName) ? 'warehouse' : 'retail'
          });
        }
        branches.sort((a, b) => {
          if (a.isOwn !== b.isOwn) return a.isOwn ? -1 : 1;
          if (a.pieces !== b.pieces) return b.pieces - a.pieces;
          return String(a.store || '').localeCompare(String(b.store || ''));
        });
        result.branches = branches;
        result.totalPieces = totalPieces;
        result.branchCount = branchCount;
      }
    } catch (err) {
      console.warn('[shopify-realtime-search] inventory batch failed:', err.message);
      /* Continue zonder inventory voor deze chunk — beter half-resultaat dan crash */
    }
  }

  const payload = {
    results,
    totalMatched: results.length,
    shopifyQuery,
    productCount: products.length
  };

  /* Memory-cache opslaan */
  __MEM_CACHE__.set(cacheKey, { data: payload, at: Date.now() });
  /* Cache-pruning om memory bound te houden */
  if (__MEM_CACHE__.size > 100) {
    const oldest = [...__MEM_CACHE__.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) __MEM_CACHE__.delete(oldest[0]);
  }

  return { ...payload, cached: false };
}

export function clearRealtimeSearchCache() {
  __MEM_CACHE__.clear();
}
