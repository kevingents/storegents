/**
 * lib/report-builder-templates-store.js
 *
 * Blob-backed store voor saved templates van de Rapport-bouwer.
 *
 * Schema in blob `admin/report-builder-templates.json`:
 *   { templates: [
 *       { id, name, owner, ownerEmail, source, query, sharedWith[], createdAt, updatedAt }
 *     ] }
 *
 * - owner       : actor (email of userId) van de maker
 * - ownerEmail  : email-adres (voor display)
 * - source      : data-source-key (bv. 'mail-log')
 * - query       : opgeslagen query-object { filters, columns, groupBy, aggregate, sortBy, sortDir, limit }
 * - sharedWith  : array van email-adressen die de template kunnen zien/laden
 *                 (eigenaar staat impliciet altijd in deze lijst)
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import crypto from 'crypto';

const BLOB_PATH = 'admin/report-builder-templates.json';
const MAX_TEMPLATES = 500;

function nowIso() { return new Date().toISOString(); }
function newId() {
  return 'rbt-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex');
}

function cleanEmail(s) {
  return String(s || '').trim().toLowerCase();
}

async function readAll() {
  const data = await readJsonBlob(BLOB_PATH, { templates: [] });
  return Array.isArray(data?.templates) ? data.templates : [];
}

async function writeAll(templates) {
  /* Cap aan MAX_TEMPLATES — verwijder oudste indien overschreden */
  let toSave = templates;
  if (templates.length > MAX_TEMPLATES) {
    toSave = templates
      .slice()
      .sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)))
      .slice(0, MAX_TEMPLATES);
  }
  await writeJsonBlob(BLOB_PATH, { templates: toSave, updatedAt: nowIso() });
  return toSave;
}

/**
 * Lijst templates die toegankelijk zijn voor `viewerEmail`.
 * Eigenaar ziet altijd alles van zichzelf; anderen alleen waar ze in `sharedWith` staan.
 * Admin (viewerEmail = '*' of leeg) ziet alles.
 */
export async function listTemplates(viewerEmail = '*') {
  const all = await readAll();
  const viewer = cleanEmail(viewerEmail);
  if (!viewer || viewer === '*') return all;
  return all.filter((t) => {
    if (cleanEmail(t.ownerEmail) === viewer) return true;
    return Array.isArray(t.sharedWith) && t.sharedWith.map(cleanEmail).includes(viewer);
  });
}

export async function getTemplate(id) {
  const all = await readAll();
  return all.find((t) => t.id === id) || null;
}

export async function createTemplate(input = {}, actor = {}) {
  const name = String(input.name || '').trim();
  const source = String(input.source || '').trim();
  if (!name)   throw new Error('name is verplicht.');
  if (!source) throw new Error('source is verplicht.');

  const all = await readAll();
  const template = {
    id: newId(),
    name,
    source,
    query: input.query || {},
    owner:      String(actor.userId || actor.email || 'admin').trim(),
    ownerEmail: cleanEmail(actor.email || actor.userId || ''),
    sharedWith: Array.isArray(input.sharedWith)
      ? input.sharedWith.map(cleanEmail).filter(Boolean)
      : [],
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  all.push(template);
  await writeAll(all);
  return template;
}

export async function updateTemplate(id, patch = {}, actor = {}) {
  const all = await readAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Template "${id}" niet gevonden.`);
  const existing = all[idx];

  /* Permissie: alleen eigenaar of admin mag updaten */
  const actorEmail = cleanEmail(actor.email || actor.userId || '');
  if (actorEmail !== '*' && actorEmail !== cleanEmail(existing.ownerEmail) && actor.role !== 'admin') {
    throw new Error('Alleen eigenaar mag template aanpassen.');
  }

  all[idx] = {
    ...existing,
    name:       patch.name       != null ? String(patch.name).trim() : existing.name,
    source:     patch.source     != null ? String(patch.source).trim() : existing.source,
    query:      patch.query      != null ? patch.query : existing.query,
    sharedWith: Array.isArray(patch.sharedWith)
      ? patch.sharedWith.map(cleanEmail).filter(Boolean)
      : existing.sharedWith,
    updatedAt: nowIso()
  };
  await writeAll(all);
  return all[idx];
}

export async function deleteTemplate(id, actor = {}) {
  const all = await readAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  const existing = all[idx];
  const actorEmail = cleanEmail(actor.email || actor.userId || '');
  if (actorEmail !== '*' && actorEmail !== cleanEmail(existing.ownerEmail) && actor.role !== 'admin') {
    throw new Error('Alleen eigenaar mag template verwijderen.');
  }
  all.splice(idx, 1);
  await writeAll(all);
  return true;
}

/**
 * Voeg of verwijder een share-email zonder volledige PATCH.
 * action: 'add' | 'remove'
 */
export async function shareTemplate(id, email, action = 'add', actor = {}) {
  const cleanEmailVal = cleanEmail(email);
  if (!cleanEmailVal) throw new Error('email is verplicht.');
  const all = await readAll();
  const idx = all.findIndex((t) => t.id === id);
  if (idx === -1) throw new Error(`Template "${id}" niet gevonden.`);
  const existing = all[idx];

  const actorEmail = cleanEmail(actor.email || actor.userId || '');
  if (actorEmail !== '*' && actorEmail !== cleanEmail(existing.ownerEmail) && actor.role !== 'admin') {
    throw new Error('Alleen eigenaar mag delen-rechten aanpassen.');
  }

  const set = new Set((existing.sharedWith || []).map(cleanEmail).filter(Boolean));
  if (action === 'remove') set.delete(cleanEmailVal);
  else set.add(cleanEmailVal);

  all[idx] = { ...existing, sharedWith: [...set], updatedAt: nowIso() };
  await writeAll(all);
  return all[idx];
}
