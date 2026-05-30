import { put, list } from '@vercel/blob';
import { getEmailForStore } from './store-emails-store.js';
import { getStoreLocation } from './gents-store-locations.js';

/**
 * Bewerkbare winkel-contactgegevens (telefoon + contactpersoon + notitie).
 *
 * De repo heeft géén centrale telefoonnummer-bron; admins vullen deze hier in.
 * E-mail komt uit store-emails-store, adres/plaats uit gents-store-locations —
 * deze store houdt alleen de handmatig-bewerkbare extra's bij.
 *
 * Bestand: store-contacts/contacts.json (Vercel Blob)
 * Structuur: { [winkelNaam]: { phone, contactName, note, updatedAt } }
 */

const PATH = 'store-contacts/contacts.json';

async function readBlobText(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Winkel-contacten konden niet worden gelezen.');
  return response.text();
}

function clean(value) { return String(value ?? '').trim(); }

async function loadAll() {
  try {
    const result = await list({ prefix: PATH, limit: 1 });
    const blob = result.blobs.find((item) => item.pathname === PATH);
    if (!blob) return {};
    const raw = await readBlobText(blob.url);
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    console.error('[store-contacts-store] read error:', error);
    return {};
  }
}

async function saveAll(map) {
  await put(PATH, JSON.stringify(map, null, 2), {
    access: 'public',
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 30
  });
}

/**
 * Volledige contact-kaart: bewerkbare velden (Blob) + afgeleide e-mail/adres.
 */
export async function getStoreContact(storeName) {
  const target = clean(storeName);
  if (!target) throw new Error('Winkel-naam ontbreekt.');
  const map = await loadAll();
  const editable = map[target] || {};
  const loc = getStoreLocation(target);
  const email = await getEmailForStore(target);
  return {
    store: target,
    phone: clean(editable.phone),
    contactName: clean(editable.contactName),
    note: clean(editable.note),
    updatedAt: editable.updatedAt || null,
    email: clean(email),
    address: loc ? clean(loc.address) : '',
    city: loc ? clean(loc.city) : ''
  };
}

export async function setStoreContact(storeName, { phone, contactName, note } = {}) {
  const target = clean(storeName);
  if (!target) throw new Error('Winkel-naam ontbreekt.');
  const phone2 = clean(phone);
  if (phone2 && !/^[+0-9()./\s-]{5,}$/.test(phone2)) {
    throw new Error('Ongeldig telefoonnummer.');
  }
  const map = await loadAll();
  const entry = {
    phone: phone2,
    contactName: clean(contactName),
    note: clean(note),
    updatedAt: new Date().toISOString()
  };
  /* Niets ingevuld → verwijder de override zodat alleen afgeleide data overblijft */
  if (!entry.phone && !entry.contactName && !entry.note) {
    delete map[target];
  } else {
    map[target] = entry;
  }
  await saveAll(map);
  return getStoreContact(target);
}
