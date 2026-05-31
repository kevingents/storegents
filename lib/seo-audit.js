/**
 * lib/seo-audit.js
 *
 * On-page SEO-audit van de Shopify-webshop. Scant alle producten en signaleert
 * SEO-gaten die je direct kunt fixen: ontbrekende meta-descriptions, te lange/
 * korte titels, dunne content, ontbrekende alt-teksten en dubbele titels.
 * Alleen producten die online zichtbaar zijn (ACTIVE + op Online Store) tellen
 * mee — voor verborgen producten is SEO niet relevant.
 *
 * Read-only richting Shopify. Resultaat wordt gecached in Blob.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const AUDIT_PATH = 'shopify-products/seo-audit.json';
const MAX_AGE_MS = Number(process.env.SEO_AUDIT_MAX_AGE_MS || 6 * 60 * 60 * 1000);
const MAX_PER_BUCKET = 1000;

/* Ideaal-grenzen (Google truncatie-richtlijnen). */
const TITLE_MIN = 20, TITLE_MAX = 60;
const META_MIN = 70, META_MAX = 160;
const BODY_MIN = 50; /* tekens platte tekst — minder = dunne content */

function getConfig() {
  const shop = (process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const token = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
  const version = process.env.SHOPIFY_API_VERSION || '2025-01';
  if (!shop || !token) return null;
  return { shop, token, version };
}

const clean = (v) => String(v == null ? '' : v).trim();
const stripHtml = (h) => String(h || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

const SEO_QUERY = `
  query SeoAudit($cursor: String) {
    products(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        title
        handle
        status
        onlineStoreUrl
        seo { title description }
        descriptionHtml
        featuredImage { altText }
      }
    }
  }`;

async function fetchAllProducts(cfg) {
  const out = [];
  let cursor = null, pages = 0;
  const MAX_PAGES = 500;
  while (pages < MAX_PAGES) {
    const resp = await fetch(`https://${cfg.shop}/admin/api/${cfg.version}/graphql.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': cfg.token, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query: SEO_QUERY, variables: { cursor } })
    });
    if (!resp.ok) throw new Error(`Shopify GraphQL ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 300)}`);
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

/** Voer de on-page SEO-audit uit (live Shopify-scan), classificeer, cache. */
export async function runSeoAudit() {
  const cfg = getConfig();
  if (!cfg) throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt.');

  const { products, pages } = await fetchAllProducts(cfg);

  const BUCKET_KEYS = ['geenMetaDescription', 'metaLengte', 'titelLengte', 'geenOmschrijving', 'geenAltText', 'dubbeleTitel'];
  const buckets = Object.fromEntries(BUCKET_KEYS.map((k) => [k, []]));
  const bucketCounts = Object.fromEntries(BUCKET_KEYS.map((k) => [k, 0]));
  const add = (key, item) => { bucketCounts[key] += 1; if (buckets[key].length < MAX_PER_BUCKET) buckets[key].push(item); };

  const counts = { totaal: 0, zichtbaar: 0, zonderProbleem: 0 };
  const titleSeen = new Map(); /* effectieve titel → [rows] voor duplicaat-detectie */

  for (const node of products) {
    counts.totaal += 1;
    const status = clean(node.status).toUpperCase();
    const online = Boolean(node.onlineStoreUrl);
    if (status !== 'ACTIVE' || !online) continue; /* SEO telt alleen voor zichtbare producten */
    counts.zichtbaar += 1;

    const idNum = clean(node.id).replace(/^gid:\/\/shopify\/Product\//, '');
    const titelSeo = clean(node.seo?.title);
    const effTitle = titelSeo || clean(node.title);
    const meta = clean(node.seo?.description);
    const bodyLen = stripHtml(node.descriptionHtml).length;
    const hasImg = node.featuredImage != null;
    const altMissing = hasImg && !clean(node.featuredImage?.altText);

    const row = {
      title: clean(node.title),
      handle: clean(node.handle),
      seoTitle: titelSeo,
      titelLengte: effTitle.length,
      metaLengte: meta.length,
      bodyLengte: bodyLen,
      onlineUrl: clean(node.onlineStoreUrl),
      adminUrl: idNum ? `https://${cfg.shop}/admin/products/${idNum}` : ''
    };

    let problemen = 0;
    if (!meta) { add('geenMetaDescription', row); problemen += 1; }
    else if (meta.length < META_MIN || meta.length > META_MAX) { add('metaLengte', row); problemen += 1; }
    if (effTitle.length < TITLE_MIN || effTitle.length > TITLE_MAX) { add('titelLengte', row); problemen += 1; }
    if (bodyLen < BODY_MIN) { add('geenOmschrijving', row); problemen += 1; }
    if (altMissing) { add('geenAltText', row); problemen += 1; }

    const lc = effTitle.toLowerCase();
    if (lc) { (titleSeen.get(lc) || titleSeen.set(lc, []).get(lc)).push(row); }

    if (problemen === 0) counts.zonderProbleem += 1;
  }

  /* Dubbele titels: alle titels die bij ≥2 zichtbare producten voorkomen. */
  for (const [, rowsForTitle] of titleSeen.entries()) {
    if (rowsForTitle.length > 1) for (const r of rowsForTitle) add('dubbeleTitel', r);
  }

  /* SEO-score: % zichtbare producten zonder enig on-page-probleem. */
  const score = counts.zichtbaar ? Math.round((counts.zonderProbleem / counts.zichtbaar) * 100) : 0;

  const result = {
    refreshedAt: new Date().toISOString(),
    pages,
    score,
    counts,
    bucketCounts,
    grenzen: { TITLE_MIN, TITLE_MAX, META_MIN, META_MAX, BODY_MIN },
    truncated: BUCKET_KEYS.some((k) => bucketCounts[k] > MAX_PER_BUCKET),
    buckets
  };

  try { await writeJsonBlob(AUDIT_PATH, result); } catch (e) { /* cache optioneel */ }
  return result;
}

export async function readSeoAudit() {
  return readJsonBlob(AUDIT_PATH, null);
}

export function isSeoAuditFresh(audit) {
  if (!audit?.refreshedAt) return false;
  return (Date.now() - new Date(audit.refreshedAt).getTime()) < MAX_AGE_MS;
}
