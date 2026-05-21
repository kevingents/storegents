/**
 * Resolve emails voor mail-routing via groups.
 *
 * Gebruikt door pickup-mail-run + weborder-mail-run om voor een specifiek
 * mail-type/store extra group-recipients erbij te krijgen.
 *
 * - Office-users: email uit office-users-store
 * - SRS-personeel: geen email direct beschikbaar (SRS heeft 'm vaak niet);
 *   skip of probeer via lookup-uitbreiding
 */

import { getAllOfficeUsers } from './office-users-store.js';
import { resolveMailRecipientsForGroups } from './user-groups-store.js';

let __EMAIL_CACHE__ = null;
let __EMAIL_CACHE_AT__ = 0;
const EMAIL_CACHE_TTL_MS = 60 * 1000; /* 1 min */

async function buildEmailMap() {
  if (__EMAIL_CACHE__ && (Date.now() - __EMAIL_CACHE_AT__) < EMAIL_CACHE_TTL_MS) {
    return __EMAIL_CACHE__;
  }
  const m = new Map();
  try {
    const all = await getAllOfficeUsers();
    for (const u of Object.values(all || {})) {
      if (u?.userId && u?.email) m.set(String(u.userId).toLowerCase(), u.email);
      if (u?.email) m.set(String(u.email).toLowerCase(), u.email);
    }
  } catch (e) {
    console.warn('[mail-recipient-resolver] office-users fail:', e.message);
  }
  __EMAIL_CACHE__ = m;
  __EMAIL_CACHE_AT__ = Date.now();
  return m;
}

/**
 * Resolver-functie die past in de group-store API.
 * @param {string} memberId  personnelId of email
 * @returns {Promise<string|null>}
 */
export async function resolveMemberEmail(memberId) {
  if (!memberId) return null;
  const key = String(memberId).toLowerCase();
  /* Als 't al een email is — direct teruggeven */
  if (key.includes('@')) return memberId;
  const map = await buildEmailMap();
  return map.get(key) || null;
}

/**
 * Convenience wrapper: krijg alle emails die voor type+store moeten ontvangen.
 *
 * @param {Object} opts { type, store }
 * @returns {Promise<{ emails: string[], hasReplaceRule: boolean, groups: [] }>}
 */
export async function getGroupMailRecipients({ type, store } = {}) {
  return resolveMailRecipientsForGroups({
    type,
    store,
    resolveEmail: resolveMemberEmail
  });
}
