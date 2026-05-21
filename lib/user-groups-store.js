/**
 * Gebruikers-groepen / teams.
 *
 * Voorbeelden:
 *   - Regio Noord (leden krijgen samen mail-alerts voor hun regio)
 *   - Goedkeurings-comité (declaraties >€200 vereisen 1 lid goedkeuring)
 *   - Pickup-team Arnhem (krijgen pickup-reminders gericht)
 *   - Niet-leverbaar squad (escalatie bij voorraad-issues)
 *
 * Groepen zijn ONAFHANKELIJK van rol/afdeling — een persoon kan in meerdere
 * groepen zitten. Lidmaatschap wordt OOK opgeslagen op user-level
 * (user.groups[] in user-permissions-store) zodat lookup beide kanten op werkt.
 *
 * Schema:
 *   admin/user-groups.json = {
 *     groups: {
 *       'regio-noord': {
 *         key: 'regio-noord',
 *         name: 'Regio Noord',
 *         description: '...',
 *         color: '#0ea5e9',
 *         memberIds: ['1234', 'office-rick-at-gents-nl'],
 *         mailRecipients: ['extern@partner.nl'],   // niet-portal emails
 *         createdAt, updatedAt
 *       }
 *     }
 *   }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'admin/user-groups.json';

function clean(v) { return String(v == null ? '' : v).trim(); }
function slugifyKey(name) {
  return clean(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export async function readAllGroups() {
  const data = await readJsonBlob(STORE_PATH, { groups: {} });
  return data.groups || {};
}

export async function listGroups() {
  const all = await readAllGroups();
  return Object.values(all).sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'nl'));
}

export async function getGroup(key) {
  if (!key) return null;
  const all = await readAllGroups();
  return all[clean(key)] || null;
}

export async function upsertGroup(input = {}, actor = 'admin') {
  const key = input.key ? clean(input.key) : slugifyKey(input.name);
  if (!key) throw new Error('Group naam of key is verplicht');
  if (!input.name) throw new Error('Group naam is verplicht');

  const all = await readAllGroups();
  const existing = all[key] || {};
  const now = new Date().toISOString();

  const updated = {
    key,
    name: clean(input.name),
    description: clean(input.description) || existing.description || '',
    color: clean(input.color) || existing.color || '#64748b',
    icon: clean(input.icon) || existing.icon || 'users',
    memberIds: Array.isArray(input.memberIds)
      ? [...new Set(input.memberIds.map(clean).filter(Boolean))]
      : (existing.memberIds || []),
    mailRecipients: Array.isArray(input.mailRecipients)
      ? [...new Set(input.mailRecipients.map(clean).filter(Boolean))]
      : (existing.mailRecipients || []),
    createdAt: existing.createdAt || now,
    updatedAt: now,
    updatedBy: clean(actor) || 'admin'
  };

  all[key] = updated;
  await writeJsonBlob(STORE_PATH, { groups: all, updatedAt: now });
  return updated;
}

export async function deleteGroup(key) {
  if (!key) return false;
  const all = await readAllGroups();
  const k = clean(key);
  if (!(k in all)) return false;
  delete all[k];
  await writeJsonBlob(STORE_PATH, { groups: all, updatedAt: new Date().toISOString() });
  return true;
}

/**
 * Voeg user toe aan group (idempotent).
 */
export async function addMember(groupKey, userId, actor = 'admin') {
  const group = await getGroup(groupKey);
  if (!group) throw new Error(`Group "${groupKey}" niet gevonden`);
  const cleanUser = clean(userId);
  if (!cleanUser) throw new Error('userId is verplicht');
  if (group.memberIds.includes(cleanUser)) return group;
  group.memberIds = [...group.memberIds, cleanUser];
  return upsertGroup(group, actor);
}

/**
 * Verwijder user uit group.
 */
export async function removeMember(groupKey, userId, actor = 'admin') {
  const group = await getGroup(groupKey);
  if (!group) return null;
  const cleanUser = clean(userId);
  const before = group.memberIds.length;
  group.memberIds = group.memberIds.filter((id) => id !== cleanUser);
  if (group.memberIds.length === before) return group;
  return upsertGroup(group, actor);
}

/**
 * Alle groepen waar deze user lid van is.
 */
export async function getGroupsForUser(userId) {
  if (!userId) return [];
  const all = await readAllGroups();
  const cleanUser = clean(userId);
  return Object.values(all).filter((g) => (g.memberIds || []).includes(cleanUser));
}

/**
 * Verzamel alle mail-recipients voor een group (members met email + externe).
 *
 * @param {string} groupKey
 * @param {Function} resolveEmail  fn(memberId) → email|null (van caller)
 * @returns {Array} unieke emails
 */
export async function resolveGroupMails(groupKey, resolveEmail) {
  const group = await getGroup(groupKey);
  if (!group) return [];
  const emails = new Set();
  if (typeof resolveEmail === 'function') {
    for (const memberId of (group.memberIds || [])) {
      try {
        const e = await resolveEmail(memberId);
        if (e) emails.add(String(e).toLowerCase());
      } catch { /* skip */ }
    }
  }
  for (const e of (group.mailRecipients || [])) {
    if (e) emails.add(String(e).toLowerCase());
  }
  return [...emails];
}
