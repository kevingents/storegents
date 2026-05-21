/**
 * Voorraad-correcties (stock corrections) — Blob-backed aanvraag-systeem.
 *
 * Een winkel dient een aanvraag in (met 1 of meer artikelen, en per artikel
 * per maat een aantal). HQ keurt goed/af. Daarna kan de aanvraag op
 * "afgerond" worden gezet wanneer de SRS-correctie is doorgevoerd.
 *
 * Blob: admin/stock-corrections.json
 *   {
 *     sequence: { '2026': 42 },   // teller per jaar voor SCR-YYYY-NNNN
 *     requests: [{
 *       id: 'scr-{shortid}',
 *       requestNumber: 'SCR-2026-0042',
 *       store: 'GENTS Arnhem',
 *       requestedBy: { userId, name },
 *       requestedAt: ISO,
 *       status: 'pending' | 'approved' | 'rejected' | 'completed' | 'cancelled',
 *       articles: [{
 *         sku, barcode, shopifyProductId, shopifyVariantId,
 *         title, brand, color,
 *         sizes: [{
 *           size, sku, barcode,
 *           countType: 'absolute' | 'delta',
 *           count: number,
 *           currentStock: number   // referentie op moment van aanvraag
 *         }],
 *         reasonCode, reasonOther, note
 *       }],
 *       note,
 *       decidedBy, decidedAt, decisionNote,
 *       completedBy, completedAt, completionNote,
 *       cancelledBy, cancelledAt, cancellationReason,
 *       createdAt, updatedAt
 *     }]
 *   }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { randomBytes } from 'node:crypto';

const STORE_PATH = 'admin/stock-corrections.json';

export const STOCK_CORRECTION_STATUSES = ['pending', 'approved', 'rejected', 'completed', 'cancelled'];

/* Standaard redenen. `direction` is informatief — sommige redenen zijn typisch
   een verhoging (retour) of verlaging (diefstal), maar alle kunnen elke richting
   aannemen. UI mag dit gebruiken als hint, niet als harde validatie. */
export const STOCK_CORRECTION_REASONS = [
  { code: 'damage', label: 'Beschadigd / niet meer verkoopbaar', direction: 'down' },
  { code: 'theft', label: 'Diefstal of vermissing', direction: 'down' },
  { code: 'count-error', label: 'Telfout (inventaris-verschil)', direction: 'either' },
  { code: 'wrong-receive', label: 'Verkeerd ontvangen / verkeerde levering', direction: 'either' },
  { code: 'returned-by-customer', label: 'Retour van klant (niet via kassa)', direction: 'up' },
  { code: 'sample', label: 'Sample / showroom-stuk', direction: 'down' },
  { code: 'transfer-mismatch', label: 'Verschil bij overdracht tussen filialen', direction: 'either' },
  { code: 'srs-sync-error', label: 'SRS-sync fout (systeem-correctie)', direction: 'either' },
  { code: 'gift', label: 'Weggegeven / promotie', direction: 'down' },
  { code: 'other', label: 'Anders — toelichting verplicht', direction: 'either' }
];

function clean(v) { return String(v ?? '').trim(); }
function shortId() { return randomBytes(6).toString('hex'); }
function nowIso() { return new Date().toISOString(); }
function currentYear() { return new Date().getUTCFullYear(); }

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeStatus(v) {
  const s = clean(v).toLowerCase();
  return STOCK_CORRECTION_STATUSES.includes(s) ? s : 'pending';
}

function normalizeActor(actor) {
  if (!actor || typeof actor !== 'object') return { userId: '', name: clean(actor) || 'onbekend' };
  return {
    userId: clean(actor.userId || actor.id || ''),
    name: clean(actor.name || actor.fullName || actor.email || 'onbekend')
  };
}

function normalizeSize(input) {
  const countType = clean(input?.countType).toLowerCase() === 'absolute' ? 'absolute' : 'delta';
  return {
    size: clean(input?.size),
    sku: clean(input?.sku),
    barcode: clean(input?.barcode),
    countType,
    count: safeNumber(input?.count, 0),
    currentStock: input?.currentStock == null ? null : safeNumber(input?.currentStock, 0)
  };
}

function normalizeArticle(input) {
  const sizesRaw = Array.isArray(input?.sizes) ? input.sizes : [];
  const sizes = sizesRaw
    .map(normalizeSize)
    .filter((s) => s.count !== 0 || s.size); // behoud rijen met maat, of mét count
  const reasonCode = clean(input?.reasonCode).toLowerCase() || 'other';
  const known = STOCK_CORRECTION_REASONS.find((r) => r.code === reasonCode);
  return {
    sku: clean(input?.sku),
    barcode: clean(input?.barcode),
    shopifyProductId: clean(input?.shopifyProductId),
    shopifyVariantId: clean(input?.shopifyVariantId),
    title: clean(input?.title),
    brand: clean(input?.brand),
    color: clean(input?.color),
    sizes,
    reasonCode: known ? reasonCode : 'other',
    reasonOther: clean(input?.reasonOther),
    note: clean(input?.note)
  };
}

function validateArticles(articles) {
  if (!Array.isArray(articles) || !articles.length) {
    throw new Error('Minimaal 1 artikel is verplicht.');
  }
  for (const art of articles) {
    if (!art.sku && !art.barcode && !art.shopifyVariantId) {
      throw new Error('Elk artikel heeft minstens een SKU, barcode of variant nodig.');
    }
    if (!art.sizes.length) {
      throw new Error('Elk artikel heeft minstens 1 maat-regel nodig.');
    }
    const totalCount = art.sizes.reduce((sum, s) => sum + Math.abs(safeNumber(s.count, 0)), 0);
    if (totalCount === 0) {
      throw new Error('Geef een aantal op (delta of absoluut) voor minimaal 1 maat.');
    }
    if (art.reasonCode === 'other' && !art.reasonOther) {
      throw new Error('Bij reden "Anders" is een toelichting verplicht.');
    }
  }
}

async function readStore() {
  const data = await readJsonBlob(STORE_PATH, { sequence: {}, requests: [] });
  return {
    sequence: data.sequence && typeof data.sequence === 'object' ? data.sequence : {},
    requests: Array.isArray(data.requests) ? data.requests : []
  };
}

async function writeStore(store) {
  await writeJsonBlob(STORE_PATH, {
    sequence: store.sequence || {},
    requests: store.requests || [],
    updatedAt: nowIso()
  });
}

function nextRequestNumber(store) {
  const year = currentYear();
  const seq = (Number(store.sequence?.[year]) || 0) + 1;
  store.sequence = { ...(store.sequence || {}), [year]: seq };
  return `SCR-${year}-${String(seq).padStart(4, '0')}`;
}

export async function readAllRequests() {
  const store = await readStore();
  return store.requests;
}

export async function getRequestById(id) {
  const requests = await readAllRequests();
  return requests.find((r) => r.id === id) || null;
}

/**
 * Filter requests op:
 *  - store
 *  - status (single of array)
 *  - from/to (createdAt range — ISO date)
 *  - requestedByUserId
 */
export async function listRequests({ store, status, from, to, requestedByUserId } = {}) {
  const requests = await readAllRequests();
  const wantedStatuses = Array.isArray(status) ? status.map((s) => clean(s).toLowerCase()) : (status ? [clean(status).toLowerCase()] : null);
  const wantedStore = clean(store).toLowerCase();
  const wantedUser = clean(requestedByUserId);
  const fromIso = from ? new Date(from).toISOString() : '';
  const toIso = to ? new Date(to).toISOString() : '';

  return requests
    .filter((r) => {
      if (wantedStore && clean(r.store).toLowerCase() !== wantedStore) return false;
      if (wantedStatuses && !wantedStatuses.includes(r.status)) return false;
      if (wantedUser && clean(r.requestedBy?.userId) !== wantedUser) return false;
      if (fromIso && r.createdAt < fromIso) return false;
      if (toIso && r.createdAt > toIso) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function createRequest(input = {}, actor = null) {
  const store = clean(input.store);
  if (!store) throw new Error('store is verplicht.');
  const articles = (Array.isArray(input.articles) ? input.articles : []).map(normalizeArticle);
  validateArticles(articles);

  const all = await readStore();
  const now = nowIso();
  const id = `scr-${shortId()}`;
  const requestNumber = nextRequestNumber(all);
  const requestedBy = normalizeActor(actor || input.requestedBy);

  const request = {
    id,
    requestNumber,
    store,
    requestedBy,
    requestedAt: now,
    status: 'pending',
    articles,
    note: clean(input.note),
    decidedBy: null,
    decidedAt: null,
    decisionNote: '',
    completedBy: null,
    completedAt: null,
    completionNote: '',
    cancelledBy: null,
    cancelledAt: null,
    cancellationReason: '',
    createdAt: now,
    updatedAt: now
  };

  all.requests = [request, ...all.requests];
  await writeStore(all);
  return request;
}

/**
 * Update een bestaande aanvraag (alleen door HQ of aanvrager, voor pending).
 * Velden die je kunt updaten: articles, note.
 */
export async function updateRequest(id, input = {}, actor = null) {
  if (!id) throw new Error('id is verplicht.');
  const all = await readStore();
  const idx = all.requests.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error('Aanvraag niet gevonden.');
  const existing = all.requests[idx];
  if (existing.status !== 'pending') {
    throw new Error(`Aanvraag in status "${existing.status}" kan niet meer worden gewijzigd.`);
  }
  const articles = Array.isArray(input.articles)
    ? input.articles.map(normalizeArticle)
    : existing.articles;
  if (Array.isArray(input.articles)) validateArticles(articles);

  const updated = {
    ...existing,
    articles,
    note: input.note != null ? clean(input.note) : existing.note,
    updatedAt: nowIso(),
    lastUpdatedBy: normalizeActor(actor)
  };
  all.requests[idx] = updated;
  await writeStore(all);
  return updated;
}

async function transition(id, nextStatus, fields, actor) {
  const all = await readStore();
  const idx = all.requests.findIndex((r) => r.id === id);
  if (idx < 0) throw new Error('Aanvraag niet gevonden.');
  const existing = all.requests[idx];

  /* Status-overgangen:
       pending → approved | rejected | cancelled
       approved → completed | cancelled
       rejected → (terminal)
       completed → (terminal)
       cancelled → (terminal)
  */
  const allowed = {
    pending: ['approved', 'rejected', 'cancelled'],
    approved: ['completed', 'cancelled'],
    rejected: [],
    completed: [],
    cancelled: []
  };
  if (!allowed[existing.status]?.includes(nextStatus)) {
    throw new Error(`Status-overgang "${existing.status}" → "${nextStatus}" niet toegestaan.`);
  }

  const updated = {
    ...existing,
    ...fields,
    status: nextStatus,
    updatedAt: nowIso()
  };
  if (nextStatus === 'approved' || nextStatus === 'rejected') {
    updated.decidedBy = normalizeActor(actor);
    updated.decidedAt = nowIso();
  }
  if (nextStatus === 'completed') {
    updated.completedBy = normalizeActor(actor);
    updated.completedAt = nowIso();
  }
  if (nextStatus === 'cancelled') {
    updated.cancelledBy = normalizeActor(actor);
    updated.cancelledAt = nowIso();
  }

  all.requests[idx] = updated;
  await writeStore(all);
  return updated;
}

export async function approveRequest(id, { note = '' } = {}, actor = null) {
  return transition(id, 'approved', { decisionNote: clean(note) }, actor);
}

export async function rejectRequest(id, { note = '' } = {}, actor = null) {
  if (!clean(note)) throw new Error('Bij afkeuren is een toelichting verplicht.');
  return transition(id, 'rejected', { decisionNote: clean(note) }, actor);
}

export async function completeRequest(id, { note = '' } = {}, actor = null) {
  return transition(id, 'completed', { completionNote: clean(note) }, actor);
}

export async function cancelRequest(id, { reason = '' } = {}, actor = null) {
  return transition(id, 'cancelled', { cancellationReason: clean(reason) }, actor);
}

/**
 * Rapportage-aggregatie. Returned counts groeperen op verschillende dimensies.
 * Optioneel periode-filter via from/to (ISO date strings).
 */
export async function aggregateReport({ from, to, store } = {}) {
  const requests = await listRequests({ from, to, store });

  const total = {
    requests: requests.length,
    articleLines: 0,
    pieces: 0,
    byStatus: {},
    byReason: {},
    byStore: {},
    byUser: {}
  };

  for (const r of requests) {
    total.byStatus[r.status] = (total.byStatus[r.status] || 0) + 1;
    const storeKey = r.store || 'onbekend';
    if (!total.byStore[storeKey]) total.byStore[storeKey] = { requests: 0, articleLines: 0, pieces: 0 };
    total.byStore[storeKey].requests += 1;

    const userKey = r.requestedBy?.name || 'onbekend';
    if (!total.byUser[userKey]) total.byUser[userKey] = { requests: 0, articleLines: 0, pieces: 0 };
    total.byUser[userKey].requests += 1;

    for (const art of (r.articles || [])) {
      total.articleLines += 1;
      total.byStore[storeKey].articleLines += 1;
      total.byUser[userKey].articleLines += 1;

      const reasonKey = art.reasonCode || 'other';
      if (!total.byReason[reasonKey]) total.byReason[reasonKey] = { articleLines: 0, pieces: 0 };
      total.byReason[reasonKey].articleLines += 1;

      for (const s of (art.sizes || [])) {
        /* Pieces tellen we als absolute waarde: delta -3 of absolute 3 zijn beide
           "3 stuks gecorrigeerd" voor de rapportage. */
        const n = Math.abs(safeNumber(s.count, 0));
        total.pieces += n;
        total.byStore[storeKey].pieces += n;
        total.byUser[userKey].pieces += n;
        total.byReason[reasonKey].pieces += n;
      }
    }
  }
  return { total, requests };
}

/* Helper: lookup reden-label op basis van code. */
export function getReasonLabel(code) {
  const found = STOCK_CORRECTION_REASONS.find((r) => r.code === clean(code).toLowerCase());
  return found ? found.label : clean(code) || 'Onbekend';
}
