/**
 * Beeldherkenning voor de beeldbank: classificeert per product of er een
 * modelshot / sfeerbeeld (lifestyle) tussen de productfoto's zit, zodat de
 * beeldbank kan filteren op "Met model (sfeerbeeld)".
 *
 * Opslag in blob marketing/beeldbank-model-tags.json:
 *   { tags: { [productId]: { hasModel, img, at } }, updatedAt }
 *
 * Classificatie via Claude vision (lib/claude-client.js). Gefaseerd: per run een
 * begrensd aantal nog-niet-(of gewijzigde) producten — batch-knop + dagelijkse cron.
 */

import { readProductsCache } from './shopify-products-cache.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { claudeVision } from './claude-client.js';

const TAGS_PATH = 'marketing/beeldbank-model-tags.json';
const clean = (v) => String(v == null ? '' : v).trim();

/* Verklein een Shopify-afbeelding tot ~px breed om tokens/bandbreedte te sparen. */
function shrink(url, px = 640) {
  const u = clean(url);
  if (!u || !/cdn\.shopify\.com/i.test(u)) return u;
  return u.includes('?') ? `${u}&width=${px}` : `${u}?width=${px}`;
}

/* Dedupe variant-cache → één entry per product (max 4 afbeeldingen). */
function productsFromCache(cache) {
  const byProduct = new Map();
  for (const v of Object.values(cache?.bySku || {})) {
    const pid = v.productId || v.productHandle || v.title;
    if (!pid || byProduct.has(pid)) continue;
    const images = Array.isArray(v.images) ? v.images.filter(Boolean) : (v.image ? [v.image] : []);
    const main = clean(v.image) || images[0] || '';
    if (!main) continue;
    byProduct.set(pid, { productId: pid, title: clean(v.title) || '—', image: main, images: images.slice(0, 4) });
  }
  return [...byProduct.values()];
}

/* Producten die nog niet (of met een ander hoofdbeeld) geclassificeerd zijn. */
function selectTodo(products, tags, force = false) {
  return products.filter((p) => {
    if (force) return true;
    const t = tags[p.productId];
    return !t || t.img !== p.image;
  });
}

export async function readModelTags() {
  const blob = await readJsonBlob(TAGS_PATH, { tags: {}, updatedAt: null });
  const tags = (blob && typeof blob.tags === 'object' && blob.tags) ? blob.tags : {};
  return { tags, updatedAt: blob?.updatedAt || null };
}

export async function getModelStatus() {
  const cache = await readProductsCache().catch(() => null);
  const products = productsFromCache(cache);
  const { tags, updatedAt } = await readModelTags();
  const todo = selectTodo(products, tags, false);
  const withModel = products.reduce((n, p) => n + (tags[p.productId]?.hasModel ? 1 : 0), 0);
  return {
    total: products.length,
    classified: products.length - todo.length,
    remaining: todo.length,
    withModel,
    updatedAt
  };
}

const SYSTEM = 'Je bent een nauwkeurige beeld-classificatie-assistent voor een herenmode-webshop. Je beoordeelt uitsluitend wat je op de foto\'s ziet.';
const PROMPT = [
  'Hieronder enkele foto\'s van één product.',
  'Bevat minstens één foto een menselijk model dat de kleding draagt, of een sfeer-/lifestylebeeld in een omgeving',
  '(dus géén egale studio-packshot op een witte/effen achtergrond)?',
  'Antwoord met exact één woord: JA of NEE.'
].join(' ');

const parseYes = (text) => /^\s*ja\b/i.test(clean(text));

/**
 * Classificeer een begrensde batch producten.
 * @returns { processed, hasModel, ...status }
 */
export async function classifyBatch({ limit = 15, force = false } = {}) {
  const cache = await readProductsCache();
  if (!cache) throw new Error('Product-cache niet beschikbaar.');
  const products = productsFromCache(cache);
  const { tags: stored } = await readModelTags();
  const tags = { ...stored };

  const todo = selectTodo(products, tags, force).slice(0, Math.max(1, Math.min(100, limit)));

  let processed = 0;
  let hasModelCount = 0;
  let dirty = false;
  /* Tussentijds wegschrijven (per 5) zodat een functie-timeout geen werk verliest. */
  const flush = async () => { if (dirty) { await writeJsonBlob(TAGS_PATH, { tags, updatedAt: new Date().toISOString() }); dirty = false; } };

  for (const p of todo) {
    const urls = [p.image, ...p.images.filter((u) => u !== p.image)].slice(0, 3).map((u) => shrink(u));
    try {
      const { text } = await claudeVision({ system: SYSTEM, user: PROMPT, imageUrls: urls, maxTokens: 8, temperature: 0 });
      const hasModel = parseYes(text);
      tags[p.productId] = { hasModel, img: p.image, at: new Date().toISOString() };
      processed += 1;
      dirty = true;
      if (hasModel) hasModelCount += 1;
      if (processed % 5 === 0) await flush();
    } catch (e) {
      /* Eén fout stopt de batch niet — sla over, volgende run opnieuw. */
      console.error('[beeldbank-vision] classify mislukt', p.productId, e.message);
    }
  }
  await flush();

  const updatedAt = new Date().toISOString();

  const remainingTodo = selectTodo(products, tags, false);
  const withModel = products.reduce((n, p) => n + (tags[p.productId]?.hasModel ? 1 : 0), 0);
  return {
    processed,
    hasModel: hasModelCount,
    total: products.length,
    classified: products.length - remainingTodo.length,
    remaining: remainingTodo.length,
    withModel,
    updatedAt
  };
}
