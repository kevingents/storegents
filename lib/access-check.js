/**
 * lib/access-check.js
 *
 * Centrale "wie ben jij en waar mag je heen"-resolver. Combineert:
 *   - Request-IP (via x-vercel-forwarded-for headers)
 *   - Store-IP-config (winkel-IPs)
 *   - Per-user IP-whitelist (thuiswerk)
 *   - Admin-token check (master-pin)
 *
 * Returnt een verklarende structure die login-flow + endpoints kunnen gebruiken
 * om beslissingen te nemen ZONDER de gebruiker te dwingen handmatig in te
 * loggen wanneer hij al herkenbaar is via IP.
 */

import { getRequestIp, isPrivateIp } from './request-ip.js';
import { findStoreByIp } from './store-ip-config.js';
import { findPersonnelByIp } from './user-ip-whitelist-store.js';
import { isAdminRequest } from './cors.js';

/**
 * @returns {Promise<{
 *   ip: string,
 *   isPrivateIp: boolean,
 *   matchedStore: string|null,        // winkel waar dit IP onder valt
 *   personnelMatches: Array,           // users met dit IP in whitelist
 *   isAdmin: boolean,                  // admin-token in request?
 *   accessLevel: 'admin' | 'store' | 'whitelist' | 'none',
 *   reason: string                     // menselijke uitleg
 * }>}
 */
export async function resolveAccess(req) {
  const ip = getRequestIp(req);
  const adminRequest = isAdminRequest(req);

  if (adminRequest) {
    return {
      ip,
      isPrivateIp: isPrivateIp(ip),
      matchedStore: null,
      personnelMatches: [],
      isAdmin: true,
      accessLevel: 'admin',
      reason: 'Geldig admin-token in request — admin heeft altijd toegang.'
    };
  }

  if (!ip) {
    return {
      ip: '',
      isPrivateIp: false,
      matchedStore: null,
      personnelMatches: [],
      isAdmin: false,
      accessLevel: 'none',
      reason: 'Geen client-IP kunnen detecteren in request-headers.'
    };
  }

  /* Match 1: winkel-IP — automatisch toegang tot winkel-shell */
  const matchedStore = await findStoreByIp(ip);
  if (matchedStore) {
    return {
      ip,
      isPrivateIp: isPrivateIp(ip),
      matchedStore,
      personnelMatches: [],
      isAdmin: false,
      accessLevel: 'store',
      reason: `IP ${ip} matched met winkel ${matchedStore}.`
    };
  }

  /* Match 2: per-user IP-whitelist (thuiswerk) */
  const personnelMatches = await findPersonnelByIp(ip);
  if (personnelMatches.length > 0) {
    return {
      ip,
      isPrivateIp: isPrivateIp(ip),
      matchedStore: personnelMatches[0]?.defaultStore || null,
      personnelMatches,
      isAdmin: false,
      accessLevel: 'whitelist',
      reason: `IP ${ip} in whitelist van ${personnelMatches.length} medewerker(s).`
    };
  }

  return {
    ip,
    isPrivateIp: isPrivateIp(ip),
    matchedStore: null,
    personnelMatches: [],
    isAdmin: false,
    accessLevel: 'none',
    reason: `IP ${ip} niet herkend in winkel-IPs of user-whitelists — handmatige login vereist.`
  };
}
