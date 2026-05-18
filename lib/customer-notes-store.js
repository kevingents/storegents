import { put, list } from '@vercel/blob';

/**
 * Customer notes & tags store — per klant (customerId of email als key).
 *
 * Bestand: customer-notes/notes.json (Vercel Blob)
 * Structuur:
 * {
 *   "kev@gents.nl": {
 *     notes: [{ id, text, author, createdAt, updatedAt }],
 *     tags: [{ id, label, color, createdAt }],
 *     updatedAt
 *   }
 * }
 */

const PATH = 'customer-notes/notes.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Klant-notities kon niet worden gelezen.');
  return response.text();
}

export async function getAllCustomerNotes() {
  try {
    const result = await list({ prefix: PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === PATH);
    if (!blob) return {};
    const raw = await readBlobText(blob.url);
    return JSON.parse(raw || '{}');
  } catch (error) {
    console.error('Read customer notes error:', error);
    return {};
  }
}

async function saveAllCustomerNotes(data) {
  await put(PATH, JSON.stringify(data, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60
  });
}

function clean(value) { return String(value || '').trim(); }

function normalizeKey(customerKey) {
  return clean(customerKey).toLowerCase();
}

export async function getCustomerNotesForKey(customerKey) {
  const all = await getAllCustomerNotes();
  const key = normalizeKey(customerKey);
  return all[key] || { notes: [], tags: [], updatedAt: null };
}

export async function addCustomerNote(customerKey, { text, author }) {
  const text2 = clean(text);
  if (!text2) throw new Error('Notitie-tekst is verplicht.');
  const all = await getAllCustomerNotes();
  const key = normalizeKey(customerKey);
  const cur = all[key] || { notes: [], tags: [], updatedAt: null };
  const note = {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `n-${Date.now()}`,
    text: text2,
    author: clean(author) || 'Admin',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  cur.notes = [note, ...(cur.notes || [])];
  cur.updatedAt = new Date().toISOString();
  all[key] = cur;
  await saveAllCustomerNotes(all);
  return note;
}

export async function deleteCustomerNote(customerKey, noteId) {
  const all = await getAllCustomerNotes();
  const key = normalizeKey(customerKey);
  if (!all[key]) return false;
  const before = (all[key].notes || []).length;
  all[key].notes = (all[key].notes || []).filter((n) => n.id !== noteId);
  if (all[key].notes.length === before) return false;
  all[key].updatedAt = new Date().toISOString();
  await saveAllCustomerNotes(all);
  return true;
}

export async function addCustomerTag(customerKey, { label, color }) {
  const lbl = clean(label);
  if (!lbl) throw new Error('Tag-label is verplicht.');
  const all = await getAllCustomerNotes();
  const key = normalizeKey(customerKey);
  const cur = all[key] || { notes: [], tags: [], updatedAt: null };
  /* dedupe */
  if ((cur.tags || []).some((t) => t.label.toLowerCase() === lbl.toLowerCase())) {
    return cur.tags.find((t) => t.label.toLowerCase() === lbl.toLowerCase());
  }
  const tag = {
    id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `t-${Date.now()}`,
    label: lbl,
    color: clean(color) || 'blue',
    createdAt: new Date().toISOString()
  };
  cur.tags = [tag, ...(cur.tags || [])];
  cur.updatedAt = new Date().toISOString();
  all[key] = cur;
  await saveAllCustomerNotes(all);
  return tag;
}

export async function deleteCustomerTag(customerKey, tagId) {
  const all = await getAllCustomerNotes();
  const key = normalizeKey(customerKey);
  if (!all[key]) return false;
  const before = (all[key].tags || []).length;
  all[key].tags = (all[key].tags || []).filter((t) => t.id !== tagId);
  if (all[key].tags.length === before) return false;
  all[key].updatedAt = new Date().toISOString();
  await saveAllCustomerNotes(all);
  return true;
}

export async function setCustomerNewsletterStatus(customerKey, subscribed) {
  const all = await getAllCustomerNotes();
  const key = normalizeKey(customerKey);
  const cur = all[key] || { notes: [], tags: [], updatedAt: null };
  cur.newsletter = {
    subscribed: Boolean(subscribed),
    updatedAt: new Date().toISOString()
  };
  cur.updatedAt = new Date().toISOString();
  all[key] = cur;
  await saveAllCustomerNotes(all);
  return cur.newsletter;
}

/**
 * Voor segment-builder: lijst alle klanten met bepaalde tag.
 */
export async function getCustomersByTag(label) {
  const all = await getAllCustomerNotes();
  const lbl = clean(label).toLowerCase();
  const matches = [];
  for (const [key, val] of Object.entries(all)) {
    if ((val.tags || []).some((t) => t.label.toLowerCase() === lbl)) {
      matches.push({ key, notesCount: (val.notes || []).length, tags: val.tags });
    }
  }
  return matches;
}
