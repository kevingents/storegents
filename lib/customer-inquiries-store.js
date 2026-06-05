/**
 * lib/customer-inquiries-store.js
 *
 * Track customer-service inquiries (vooral: store-credit → cash-refund verzoeken
 * van klanten die via Returnista hadden gekozen voor een tegoedbon en alsnog
 * hun geld terug willen).
 *
 * Blob: customer-service/inquiries.json
 *   { inquiries: { <id>: { id, type, email, orderName, status, ... } }, updatedAt }
 *
 * Status-flow:
 *   new           → binnenkomend, nog niet bekeken
 *   in-progress   → admin werkt eraan (gift card disabled, refund queued)
 *   resolved      → klant heeft refund / store credit gecanceld
 *   rejected      → niet uitvoerbaar (te oud, balance op, etc.) + reden
 */

import { readJsonBlob, writeJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'customer-service/inquiries.json';

export const INQUIRY_TYPES = {
  STORE_CREDIT_TO_REFUND: 'store-credit-to-refund',
  ADDRESS_CHANGE:         'address-change',
  ORDER_QUESTION:         'order-question',
  COMPLAINT:              'complaint',
  OTHER:                  'other'
};

const clean = (v) => String(v == null ? '' : v).trim();

function genId() {
  const ts = Date.now().toString(36);
  const rnd = Math.random().toString(36).slice(2, 8);
  return `inq_${ts}_${rnd}`;
}

export async function readInquiriesState() {
  const data = await readJsonBlob(STORE_PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.inquiries && typeof data.inquiries === 'object') return data;
  return { inquiries: {}, updatedAt: null };
}

/**
 * Voeg een nieuwe inquiry toe. Returns het opgeslagen object incl. id.
 *
 * @param {Object} input
 * @param {string} input.type            INQUIRY_TYPES.* (default: STORE_CREDIT_TO_REFUND)
 * @param {string} input.email           Klant-email
 * @param {string} [input.orderName]     Order-naam (#1234) — optioneel maar handig
 * @param {string} [input.giftCardCode]  Gift card / store credit code
 * @param {number} [input.amount]        Bedrag (€) — optioneel, anders auto-detect
 * @param {string} [input.message]       Letterlijke melding van klant
 * @param {string} [input.source]        'email' / 'whatsapp' / 'phone' / 'form'
 * @param {string} [input.receivedAt]    ISO-tijd; default nu
 */
export async function addInquiry(input = {}) {
  const id = genId();
  const now = new Date().toISOString();
  const entry = {
    id,
    type: clean(input.type) || INQUIRY_TYPES.STORE_CREDIT_TO_REFUND,
    email: clean(input.email).toLowerCase(),
    orderName: clean(input.orderName).replace(/^#/, ''),
    giftCardCode: clean(input.giftCardCode),
    amount: Number.isFinite(Number(input.amount)) ? Number(input.amount) : null,
    message: clean(input.message).slice(0, 2000),
    source: clean(input.source) || 'manual',
    status: 'new',
    receivedAt: input.receivedAt || now,
    createdAt: now,
    updatedAt: now,
    resolvedAt: null,
    resolvedBy: '',
    resolution: null,
    notes: []
  };
  await mutateJsonBlob(STORE_PATH, (cur) => {
    const data = (cur && typeof cur === 'object' && cur.inquiries) ? { ...cur, inquiries: { ...cur.inquiries } } : { inquiries: {} };
    data.inquiries[id] = entry;
    data.updatedAt = now;
    return data;
  }, { fallback: { inquiries: {} } });
  return entry;
}

/**
 * Update status/notes voor een inquiry. Voor markResolved gebruik markInquiryResolved.
 */
export async function updateInquiry(id, patch = {}) {
  const key = clean(id);
  if (!key) return null;
  const now = new Date().toISOString();
  let updated = null;
  await mutateJsonBlob(STORE_PATH, (cur) => {
    const data = (cur && typeof cur === 'object' && cur.inquiries) ? { ...cur, inquiries: { ...cur.inquiries } } : { inquiries: {} };
    const existing = data.inquiries[key];
    if (!existing) return data;
    /* Whitelist patch-velden. */
    const allowed = {};
    for (const k of ['status', 'orderName', 'giftCardCode', 'amount', 'resolution', 'resolvedBy']) {
      if (patch[k] !== undefined) allowed[k] = patch[k];
    }
    if (patch.note) {
      allowed.notes = [...(existing.notes || []), { at: now, by: clean(patch.noteBy || patch.resolvedBy || 'system'), text: clean(patch.note).slice(0, 1000) }];
    }
    if (patch.status === 'resolved' || patch.status === 'rejected') {
      allowed.resolvedAt = now;
    }
    updated = { ...existing, ...allowed, updatedAt: now };
    data.inquiries[key] = updated;
    data.updatedAt = now;
    return data;
  }, { fallback: { inquiries: {} } });
  return updated;
}

export async function markInquiryResolved(id, { resolvedBy, resolution = null, note = '' } = {}) {
  return updateInquiry(id, { status: 'resolved', resolvedBy, resolution, note });
}

export async function markInquiryRejected(id, { resolvedBy, reason = '', note = '' } = {}) {
  return updateInquiry(id, { status: 'rejected', resolvedBy, resolution: { rejected: true, reason }, note: note || reason });
}

export async function getInquiry(id) {
  const key = clean(id);
  if (!key) return null;
  const data = await readInquiriesState();
  return data.inquiries?.[key] || null;
}

/**
 * Lijst inquiries — optioneel gefilterd op status of type.
 */
export async function listInquiries({ status = '', type = '', limit = 100 } = {}) {
  const data = await readInquiriesState();
  let list = Object.values(data.inquiries || {});
  if (status) list = list.filter((i) => i.status === status);
  if (type) list = list.filter((i) => i.type === type);
  list.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return list.slice(0, Math.max(1, Math.min(500, limit)));
}

export async function readInquiriesStats() {
  const data = await readInquiriesState();
  const list = Object.values(data.inquiries || {});
  const byStatus = { new: 0, 'in-progress': 0, resolved: 0, rejected: 0 };
  const byType = {};
  for (const i of list) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1;
    byType[i.type] = (byType[i.type] || 0) + 1;
  }
  return {
    total: list.length,
    byStatus,
    byType,
    last7: list.filter((i) => Date.now() - new Date(i.createdAt).getTime() < 7 * 24 * 3600 * 1000).length
  };
}

/* Reset (voor tests). */
export async function clearInquiries() {
  await writeJsonBlob(STORE_PATH, { inquiries: {}, updatedAt: new Date().toISOString() });
}
