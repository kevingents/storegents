/**
 * Functie-sjablonen — sla configuratie-templates op die in één klik op
 * gebruikers toegepast kunnen worden (rol + winkels + afdelingen + rechten).
 *
 * Snapshot-model: een sjabloon is een momentopname die eenmalig wordt
 * toegepast; bestaande rechten worden uitgebreid (niet vervangen).
 *
 * Schema:
 *   admin/function-templates.json = {
 *     templates: {
 *       'winkelmedewerker-basis': {
 *         key: 'winkelmedewerker-basis',
 *         name: 'Winkelmedewerker basis',
 *         description: '...',
 *         role: 'medewerker',
 *         stores: ['GENTS Amsterdam'],
 *         afdelingen: [],
 *         extraPermissions: [],
 *         revokedPermissions: [],
 *         color: '#64748b',
 *         icon: 'user',
 *         createdAt, updatedAt, updatedBy
 *       }
 *     }
 *   }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'admin/function-templates.json';

function clean(v) { return String(v == null ? '' : v).trim(); }
function slugifyKey(name) {
  return clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function readAllTemplates() {
  const data = await readJsonBlob(STORE_PATH, { templates: {} });
  return data.templates || {};
}

export async function listTemplates() {
  const all = await readAllTemplates();
  return Object.values(all).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'nl'));
}

export async function getTemplate(key) {
  if (!key) return null;
  const all = await readAllTemplates();
  return all[clean(key)] || null;
}

export async function upsertTemplate(input = {}, actor = 'admin') {
  const key = input.key ? clean(input.key) : slugifyKey(input.name);
  if (!key) throw new Error('Sjabloon naam of key is verplicht');
  if (!input.name) throw new Error('Sjabloon naam is verplicht');

  const all = await readAllTemplates();
  const existing = all[key] || {};
  const now = new Date().toISOString();

  const updated = {
    key,
    name: clean(input.name),
    description: clean(input.description) || existing.description || '',
    role: clean(input.role) || existing.role || '',
    stores: Array.isArray(input.stores)
      ? [...new Set(input.stores.map(clean).filter(Boolean))]
      : (existing.stores || []),
    afdelingen: Array.isArray(input.afdelingen)
      ? [...new Set(input.afdelingen.map(clean).filter(Boolean))]
      : (existing.afdelingen || []),
    extraPermissions: Array.isArray(input.extraPermissions)
      ? [...new Set(input.extraPermissions.filter(Boolean))]
      : (existing.extraPermissions || []),
    revokedPermissions: Array.isArray(input.revokedPermissions)
      ? [...new Set(input.revokedPermissions.filter(Boolean))]
      : (existing.revokedPermissions || []),
    color: clean(input.color) || existing.color || '#64748b',
    icon: clean(input.icon) || existing.icon || 'user',
    createdAt: existing.createdAt || now,
    updatedAt: now,
    updatedBy: clean(actor) || 'admin'
  };

  all[key] = updated;
  await writeJsonBlob(STORE_PATH, { templates: all, updatedAt: now });
  return updated;
}

export async function deleteTemplate(key) {
  if (!key) return false;
  const all = await readAllTemplates();
  const k = clean(key);
  if (!(k in all)) return false;
  delete all[k];
  await writeJsonBlob(STORE_PATH, { templates: all, updatedAt: new Date().toISOString() });
  return true;
}
