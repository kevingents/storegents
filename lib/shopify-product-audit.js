/**
 * lib/shopify-product-audit.js
 *
 * Product-zichtbaarheid-audit voor de Shopify-webshop. Vindt producten die
 * "klaar lijken om te verkopen" (voorraad + afbeelding) maar tóch niet
 * zichtbaar/koopbaar zijn online, plus data-kwaliteit-gaten (geen categorie,
 * geen sales channel).
 *
 * Vragen die dit beantwoordt:
 *   1. Welke producten hebben WEL voorraad + afbeelding maar zijn NIET zichtbaar
 *      in de winkel (draft/archived/niet op Online Store)?  → bucket verborgenMetVoorraad
 *   2. Welke producten zijn niet gepubliceerd / archived / zonder sales channel?
 *      → buckets draft, archived, geenSalesChannel
 *   3. Welke producten zitten niet in een categorie?  → bucket geenCategorie
 *
 * Bron: Shopify Admin GraphQL (status, totalInventory, publishedAt,
 * onlineStoreUrl, category, resourcePublicationsCount). Read-only: schrijft
 * niets terug naar Shopify. Resultaat wordt gecached in Blob.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const AUDIT_PATH = 'shopify-products/audit.json';
const MAX_AGE_MS = Number(process.env.SHOPIFY_AUDIT_MAX_AGE_MS || 6 * 60 * 60 * 1000); /* 6u */
const MAX_PER_BUCKET = 1000; /* cap lijstgrootte; counts blijven volledig */

function getConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

const clean = (v) => String(v == null ? '' : v).trim();

const AUDIT_QUERY = `
  query ProductAudit($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        totalInventory
        publishedAt
        onlineStoreUrl
        productType
        vendor
        tags
        featuredImage { url }
        category { name fullName }
        resourcePublicationsCount { count }
        collections(first: 1) { nodes { id } }
      }
    }
  }`;

async function fetchAllProducts(cfg) {
  const out = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 500;
  while (pages < MAX_PAGES) {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': cfg.token,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ query: AUDIT_QUERY, variables: { cursor } })
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error(`Shopify GraphQL ${resp.status}: ${t.slice(0, 300)}`);
    }
    const json = await resp.json();
    if (json.errors) throw new Error(`Shopify GraphQL errors: ${JSON.stringify(json.errors).slice(0, 400)}`);
    const conn = json.data?.products;
    if (!conn) break;
    for (const n of (conn.nodes || [])) out.push(n);
    pages += 1;
    if (!conn.pageInfo?.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { products: out, pages };
}

/** Classificeer één product naar audit-signalen. */
function classify(node) {
  const status = clean(node.status).toUpperCase();          /* ACTIVE | DRAFT | ARCHIVED */
  const inv = Number(node.totalInventory || 0);
  const hasImage = Boolean(node.featuredImage?.url);
  const onOnlineStore = Boolean(node.onlineStoreUrl);        /* zichtbaar op Online Store */
  const channels = Number(node.resourcePublicationsCount?.count || 0);
  const categoryName = clean(node.category?.name) || clean(node.category?.fullName);
  const productType = clean(node.productType);
  const inCollection = Array.isArray(node.collections?.nodes) && node.collections.nodes.length > 0;

  /* "Zichtbaar/koopbaar in de winkel" = actief én daadwerkelijk op de Online Store. */
  const visible = status === 'ACTIVE' && onOnlineStore;
  /* Categorie aanwezig = Shopify-categorie OF (fallback) een producttype. */
  const hasCategory = Boolean(categoryName) || Boolean(productType);

  return { status, inv, hasImage, onOnlineStore, channels, categoryName, productType, inCollection, visible, hasCategory };
}

function row(node, c, shop) {
  const idNum = clean(node.id).replace(/^gid:\/\/shopify\/Product\//, '');
  return {
    id: idNum,
    title: clean(node.title),
    handle: clean(node.handle),
    status: c.status,
    voorraad: c.inv,
    heeftAfbeelding: c.hasImage,
    opOnlineStore: c.onOnlineStore,
    salesChannels: c.channels,
    categorie: c.categoryName || '',
    productType: c.productType || '',
    inCollectie: c.inCollection,
    adminUrl: idNum ? `https://${shop}/admin/products/${idNum}` : ''
  };
}

/**
 * Voer de audit uit (live Shopify-scan), classificeer, schrijf naar Blob.
 * @returns {Promise<object>} het volledige audit-resultaat
 */
export async function runProductAudit() {
  const cfg = getConfig();
  if (!cfg) throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt.');

  const { products, pages } = await fetchAllProducts(cfg);

  const BUCKET_KEYS = ['verborgenMetVoorraad', 'draft', 'archived', 'geenSalesChannel', 'geenCategorie'];
  const buckets = Object.fromEntries(BUCKET_KEYS.map((k) => [k, []]));
  const bucketCounts = Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0]));
  const counts = { totaal: 0, actief: 0, draft: 0, archived: 0, zichtbaar: 0, metVoorraad: 0, metAfbeelding: 0 };

  /* Tel altijd het volledige aantal; bewaar alleen de eerste MAX_PER_BUCKET rijen. */
  const add = (key, node, c) => {
    bucketCounts[key] += 1;
    if (buckets[key].length < MAX_PER_BUCKET) buckets[key].push(row(node, c, cfg.shop));
  };

  for (const node of products) {
    const c = classify(node);
    counts.totaal += 1;
    if (c.status === 'ACTIVE') counts.actief += 1;
    if (c.status === 'DRAFT') counts.draft += 1;
    if (c.status === 'ARCHIVED') counts.archived += 1;
    if (c.visible) counts.zichtbaar += 1;
    if (c.inv > 0) counts.metVoorraad += 1;
    if (c.hasImage) counts.metAfbeelding += 1;

    /* 1. Klaar om te verkopen (voorraad + afbeelding) maar onzichtbaar. */
    if (c.inv > 0 && c.hasImage && !c.visible) add('verborgenMetVoorraad', node, c);
    /* 2. Status/kanaal-gaten. */
    if (c.status === 'DRAFT') add('draft', node, c);
    if (c.status === 'ARCHIVED') add('archived', node, c);
    if (c.channels === 0 || !c.onOnlineStore) add('geenSalesChannel', node, c);
    /* 3. Geen categorie (geen Shopify-categorie én geen producttype). */
    if (!c.hasCategory) add('geenCategorie', node, c);
  }

  const result = {
    refreshedAt: new Date().toISOString(),
    pages,
    counts,
    bucketCounts,
    truncated: BUCKET_KEYS.some((k) => bucketCounts[k] > MAX_PER_BUCKET),
    buckets
  };

  try { await writeJsonBlob(AUDIT_PATH, result); } catch (e) { /* cache is optioneel */ }
  return result;
}

/** Lees de gecachte audit (of null). */
export async function readProductAudit() {
  return readJsonBlob(AUDIT_PATH, null);
}

/** Cache fresh? */
export function isAuditFresh(audit) {
  if (!audit?.refreshedAt) return false;
  return (Date.now() - new Date(audit.refreshedAt).getTime()) < MAX_AGE_MS;
}
