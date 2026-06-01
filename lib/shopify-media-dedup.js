/**
 * lib/shopify-media-dedup.js
 *
 * Spoort dubbele PRODUCTFOTO'S op (exact dezelfde afbeelding, meerdere keren op
 * één product) en kan ze in bulk uit Shopify verwijderen. Detectie op
 * content-hash (sha256 van de afbeelding-bytes) → alleen écht identieke
 * afbeeldingen worden als duplicaat gezien; verschillende foto's blijven staan.
 * De EERSTE van elke groep blijft behouden (de volgorde van Shopify-media, dus
 * meestal de hoofdfoto).
 *
 * Verwijderen is onomkeerbaar → de endpoints draaien standaard dry-run en
 * verwijderen pas bij apply=true.
 */

import crypto from 'crypto';
import { shopifyGraphql } from './shopify-gift-card-client.js';
import { readProductsCache } from './shopify-products-cache.js';

const MAX_IMG_BYTES = 8 * 1024 * 1024;
const HASH_CONCURRENCY = 5;

const clean = (v) => String(v == null ? '' : v).trim();

async function runLimited(items, concurrency, worker) {
  const out = [];
  let idx = 0;
  async function runner() {
    while (idx < items.length) { const i = idx++; out[i] = await worker(items[i], i); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => runner()));
  return out;
}

/* Unieke producten uit de cache: productId (Shopify GID) + aantal cache-afbeeldingen. */
function uniqueProducts(cache) {
  const byId = new Map();
  for (const bucket of ['bySku', 'byBarcode', 'bySrsArticleNumber']) {
    for (const v of Object.values(cache?.[bucket] || {})) {
      const pid = clean(v.productId);
      if (!pid || byId.has(pid)) continue;
      byId.set(pid, { productId: pid, title: v.title || '', images: Array.isArray(v.images) ? v.images.length : 0 });
    }
  }
  return [...byId.values()];
}

/* Alle MediaImage's van één product (id + originele url), in Shopify-volgorde. */
async function getProductMedia(productId) {
  const data = await shopifyGraphql(
    `query($id: ID!) {
      product(id: $id) {
        id title
        media(first: 100) {
          nodes { id mediaContentType ... on MediaImage { image { url } } }
        }
      }
    }`,
    { id: productId }
  );
  const p = data?.product;
  if (!p) return { title: '', media: [] };
  const media = (p.media?.nodes || [])
    .filter((n) => n.mediaContentType === 'IMAGE' && n.image?.url)
    .map((n) => ({ mediaId: n.id, url: n.image.url }));
  return { title: p.title || '', media };
}

async function hashImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > MAX_IMG_BYTES) throw new Error('afbeelding te groot');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_IMG_BYTES) throw new Error('afbeelding te groot');
    return crypto.createHash('sha256').update(buf).digest('hex');
  } finally {
    clearTimeout(timer);
  }
}

/* Dubbele media (zelfde bytes). Houdt de eerste per groep; returnt de rest. */
async function findDuplicateMedia(media) {
  const hashed = await runLimited(media, HASH_CONCURRENCY, async (m) => {
    try { return { ...m, hash: await hashImage(m.url) }; } catch { return { ...m, hash: null }; }
  });
  const seen = new Set();
  const dupes = [];
  for (const m of hashed) {
    if (!m.hash) continue;          /* niet gehasht → laat staan (veilig) */
    if (seen.has(m.hash)) dupes.push(m);
    else seen.add(m.hash);
  }
  return dupes;
}

/**
 * Dedupliceer één product. Dry-run tenzij apply=true.
 * @returns {{productId, title, total, duplicateCount, duplicates:[{mediaId,url}], deleted}}
 */
export async function dedupeProduct(productId, { apply = false } = {}) {
  const pid = clean(productId);
  const { title, media } = await getProductMedia(pid);
  if (media.length < 2) {
    return { productId: pid, title, total: media.length, duplicateCount: 0, duplicates: [], deleted: 0 };
  }
  const dupes = await findDuplicateMedia(media);
  let deleted = 0;
  if (apply && dupes.length) {
    const ids = dupes.map((d) => d.mediaId);
    const data = await shopifyGraphql(
      `mutation($pid: ID!, $ids: [ID!]!) {
        productDeleteMedia(productId: $pid, mediaIds: $ids) {
          deletedMediaIds
          mediaUserErrors { field message }
        }
      }`,
      { pid, ids }
    );
    const errs = data?.productDeleteMedia?.mediaUserErrors || [];
    if (errs.length) throw new Error(errs.map((e) => e.message).join('; '));
    deleted = (data?.productDeleteMedia?.deletedMediaIds || []).length;
  }
  return {
    productId: pid,
    title,
    total: media.length,
    duplicateCount: dupes.length,
    duplicates: dupes.map((d) => ({ mediaId: d.mediaId, url: d.url })),
    deleted
  };
}

/**
 * Scan een batch producten (meeste foto's eerst). Dry-run tenzij apply=true.
 * Frontend loopt door met nextOffset tot done=true.
 * @returns {{scanned, totalCandidates, nextOffset, done, productsWithDupes, duplicateCount, deleted, products:[...]}}
 */
export async function scanForDuplicates({ limit = 6, offset = 0, apply = false, minImages = 2 } = {}) {
  const cache = await readProductsCache();
  const candidates = uniqueProducts(cache)
    .filter((p) => (p.images || 0) >= minImages)
    .sort((a, b) => (b.images || 0) - (a.images || 0));
  const slice = candidates.slice(offset, offset + limit);

  const products = [];
  let dupTotal = 0;
  let delTotal = 0;
  for (const p of slice) {
    try {
      const r = await dedupeProduct(p.productId, { apply });
      if (r.duplicateCount > 0) products.push(r);
      dupTotal += r.duplicateCount;
      delTotal += r.deleted;
    } catch (e) {
      products.push({ productId: p.productId, title: p.title, error: e.message || String(e) });
    }
  }
  const nextOffset = offset + slice.length;
  return {
    scanned: slice.length,
    totalCandidates: candidates.length,
    nextOffset,
    done: nextOffset >= candidates.length,
    productsWithDupes: products.filter((p) => !p.error && p.duplicateCount > 0).length,
    duplicateCount: dupTotal,
    deleted: delTotal,
    products
  };
}
