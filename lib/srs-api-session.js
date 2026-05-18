/**
 * SRS API user session cache (in-memory, per warm container).
 *
 * SRS API user webservices (si_webshop, si_weborder, si_spaarpunten,
 * si_voucherservice, si_kadobon) verlangen een Login → session_id voordat
 * je de daadwerkelijke methode mag aanroepen. De docs zeggen:
 *
 *   "Elk Session ID blijft 24 minuten geldig."
 *
 * Voorheen deden we per request een nieuwe Login. Dat is ~1 extra HTTP roundtrip
 * (gemiddeld 200-400ms tegen storeinfo.nl) per call. Bij polling endpoints,
 * cron-jobs en bulk-loaders telt dat snel op.
 *
 * Deze cache houdt session_ids per service-key vast op module-niveau. Op een
 * warme Vercel container delen invocations dezelfde cache. Bij een verlopen
 * sessie (SRS gooit een fault zoals "Session not valid" of HTTP 401/500) roept
 * de client invalidateSession(key) aan en doet automatisch een retry met
 * verse login.
 *
 * TTL = 20 min (van de 24 min houden we 4 min buffer voor klokverschil).
 */

const DEFAULT_TTL_MS = 20 * 60 * 1000;

/** @type {Map<string, { sessionId: string, expiresAt: number, promise?: Promise<string> }>} */
const cache = new Map();

function now() {
  return Date.now();
}

function isFresh(entry, ttlMs) {
  if (!entry || !entry.sessionId) return false;
  return entry.expiresAt - now() > 0 && entry.expiresAt - now() <= ttlMs;
}

/**
 * Verkrijg een (gecachede) SRS API session_id voor de gegeven service-key.
 *
 * @param {string} serviceKey  - bv 'si_weborder', 'si_spaarpunten', 'si_voucherservice'
 * @param {() => Promise<string>} loginFn - functie die een verse session_id ophaalt via SRS Login
 * @param {{ ttlMs?: number }} [options]
 * @returns {Promise<string>} session_id
 */
export async function getCachedSession(serviceKey, loginFn, options = {}) {
  if (!serviceKey) throw new Error('getCachedSession: serviceKey ontbreekt.');
  if (typeof loginFn !== 'function') throw new Error('getCachedSession: loginFn ontbreekt.');

  const ttlMs = Number(options.ttlMs) > 0 ? Number(options.ttlMs) : DEFAULT_TTL_MS;
  const entry = cache.get(serviceKey);

  if (entry && entry.sessionId && entry.expiresAt > now()) {
    return entry.sessionId;
  }

  /* Voorkom thundering herd: parallelle calls op dezelfde key delen één login-call. */
  if (entry && entry.promise) {
    return entry.promise;
  }

  const promise = (async () => {
    const sessionId = await loginFn();
    if (!sessionId) {
      throw new Error(`SRS Login voor ${serviceKey} gaf geen session_id terug.`);
    }
    cache.set(serviceKey, {
      sessionId,
      expiresAt: now() + ttlMs
    });
    return sessionId;
  })();

  cache.set(serviceKey, {
    sessionId: '',
    expiresAt: 0,
    promise
  });

  try {
    return await promise;
  } catch (error) {
    cache.delete(serviceKey);
    throw error;
  }
}

/**
 * Markeer een service-sessie als ongeldig (bv. na een "Session not valid" fout).
 * Volgende getCachedSession() doet automatisch een verse Login.
 */
export function invalidateSession(serviceKey) {
  if (!serviceKey) return;
  cache.delete(serviceKey);
}

/**
 * Forceer een verse session_id (negeert cache).
 */
export async function refreshSession(serviceKey, loginFn, options = {}) {
  invalidateSession(serviceKey);
  return getCachedSession(serviceKey, loginFn, options);
}

/**
 * Wrap een SRS API call met automatische session-retry.
 *
 * Voorbeeld:
 *   const result = await withSession('si_spaarpunten', loginSrsPointsService, async (sessionId) => {
 *     return await postSoap('getSaldo', xml(sessionId));
 *   });
 *
 * Als de inner call faalt met een sessie-gerelateerde fout, wordt de cache
 * geleegd en de call één keer opnieuw geprobeerd met een verse session_id.
 */
export async function withSession(serviceKey, loginFn, useSessionFn, options = {}) {
  const sessionId = await getCachedSession(serviceKey, loginFn, options);

  try {
    return await useSessionFn(sessionId);
  } catch (error) {
    if (isSessionError(error)) {
      invalidateSession(serviceKey);
      const fresh = await getCachedSession(serviceKey, loginFn, options);
      return useSessionFn(fresh);
    }
    throw error;
  }
}

const SESSION_ERROR_HINTS = [
  'session not valid',
  'session invalid',
  'session expired',
  'session id',
  'session_id',
  'sessionid',
  'session timeout',
  'invalid session',
  'login is required',
  'authentication failed',
  'not logged in',
  'niet ingelogd'
];

export function isSessionError(error) {
  if (!error) return false;
  const status = Number(error.status);
  if (status === 401) return true;

  const blob = String(
    error.fault?.message ||
    error.message ||
    error.responseText ||
    ''
  ).toLowerCase();

  return SESSION_ERROR_HINTS.some((hint) => blob.includes(hint));
}

/**
 * Debug helper.
 */
export function getSessionCacheStats() {
  const stats = [];
  for (const [key, entry] of cache.entries()) {
    stats.push({
      key,
      hasSession: Boolean(entry?.sessionId),
      msUntilExpire: entry?.expiresAt ? entry.expiresAt - now() : 0,
      pending: Boolean(entry?.promise && !entry?.sessionId)
    });
  }
  return stats;
}
