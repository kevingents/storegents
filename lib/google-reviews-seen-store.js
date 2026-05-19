/**
 * Track welke Google reviews al "gezien" zijn per winkel.
 *
 * Doel: medewerkers kunnen zien welke reviews NIEUW zijn sinds laatste bezoek.
 * Bij elke ophaling van de reviews-lijst markeren we de huidige IDs als gezien
 * (handmatige actie of automatisch bij modal-open).
 *
 * Blob layout:
 *   google-reviews/seen/<winkelKey>.json
 *   { store, seenIds: ['id1','id2',...], updatedAt }
 *
 * SeenIds zijn hashes of native Google review IDs (afhankelijk van API).
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH_PREFIX = 'google-reviews/seen/';
const MAX_SEEN_IDS = 500; /* Hard cap zodat blob niet onbeperkt groeit */

function storeKey(store) {
  return String(store || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function pathFor(store) {
  const key = storeKey(store);
  if (!key) throw new Error('google-reviews-seen: lege store-key');
  return `${PATH_PREFIX}${key}.json`;
}

function deriveReviewId(review) {
  /* Google geeft soms 'time' (epoch) + author. Combineer als stabiele key. */
  if (review.id) return String(review.id);
  if (review.reviewId) return String(review.reviewId);
  const time = String(review.time || review.publishedAt || review.createdAt || '').trim();
  const author = String(review.author || review.authorName || review.author_name || '').trim();
  if (time && author) return `${time}::${author}`;
  /* Fallback: hash van tekst */
  const text = String(review.text || review.comment || '').slice(0, 100);
  return `${author || 'anon'}::${text}`;
}

export async function readSeenIds(store) {
  if (!store) return new Set();
  try {
    const data = await readJsonBlob(pathFor(store), null);
    if (!data || !Array.isArray(data.seenIds)) return new Set();
    return new Set(data.seenIds);
  } catch (_e) {
    return new Set();
  }
}

export async function markReviewsSeen(store, reviewIds = []) {
  if (!store) return { added: 0 };
  const cleanIds = (Array.isArray(reviewIds) ? reviewIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  if (!cleanIds.length) return { added: 0 };

  const existing = await readSeenIds(store);
  let added = 0;
  for (const id of cleanIds) {
    if (!existing.has(id)) {
      existing.add(id);
      added += 1;
    }
  }

  /* Cap op MAX_SEEN_IDS — verwijder oudste (eerste in iteratie) */
  let final = Array.from(existing);
  if (final.length > MAX_SEEN_IDS) {
    final = final.slice(final.length - MAX_SEEN_IDS);
  }

  await writeJsonBlob(pathFor(store), {
    store,
    seenIds: final,
    seenCount: final.length,
    updatedAt: new Date().toISOString()
  });

  return { added, total: final.length };
}

/**
 * Verrijk een lijst reviews met `id` (derived) + `isNew` flag.
 */
export async function flagNewReviews(store, reviews = []) {
  const seen = await readSeenIds(store);
  return (reviews || []).map((r) => {
    const id = deriveReviewId(r);
    return {
      ...r,
      id: r.id || id,
      derivedId: id,
      isNew: !seen.has(id)
    };
  });
}

export { deriveReviewId };
