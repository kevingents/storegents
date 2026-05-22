/**
 * Cron auto-tracker — wrapper die rondom een bestaande cron-handler
 * automatisch lastRun + lastStatus + duration bijwerkt in de cron-config blob.
 *
 * Geen invasieve refactor nodig: vervang `export default async function handler`
 * door:
 *
 *   import { trackedCron } from '../../lib/cron-auto-track.js';
 *
 *   async function handler(req, res) { ... bestaande code ... }
 *
 *   export default trackedCron('cron-key', handler);
 *
 * Hierdoor verschijnen alle crons in de Cron-overzicht-pagina met juiste status.
 */

import { recordCronRun } from './cron-config-store.js';

export function trackedCron(key, handler) {
  return async function trackedHandler(req, res) {
    const startedAt = Date.now();
    let trackedFailure = null;

    /* Capture res.status calls om de uiteindelijke HTTP status te detecteren.
       Vercel handlers gebruiken meestal res.status(N).json(...) chains. */
    let lastHttpStatus = 200;
    const origStatus = res.status?.bind(res);
    if (typeof origStatus === 'function') {
      res.status = function trackedStatus(code) {
        lastHttpStatus = code;
        return origStatus(code);
      };
    }

    try {
      const result = await handler(req, res);
      const durationMs = Date.now() - startedAt;
      const ok = lastHttpStatus >= 200 && lastHttpStatus < 400;
      /* await zodat Vercel de functie niet freezet voor de blob-write klaar is.
         De HTTP-response is al verstuurd via res.json() — dit vertraagt de
         browser-response niet, maar houdt de serverless-instantie wel levend. */
      await recordCronRun(key, {
        status: ok ? 'success' : (lastHttpStatus === 207 ? 'partial' : 'failed'),
        durationMs,
        error: ok ? '' : `HTTP ${lastHttpStatus}`,
        summary: null
      }).catch((e) => console.warn(`[cron-auto-track] recordCronRun faalde voor ${key}:`, e.message));
      return result;
    } catch (err) {
      trackedFailure = err;
      const durationMs = Date.now() - startedAt;
      await recordCronRun(key, {
        status: 'failed',
        durationMs,
        error: String(err?.message || err || 'onbekend').slice(0, 500),
        summary: null
      }).catch((e) => console.warn(`[cron-auto-track] recordCronRun faalde voor ${key}:`, e.message));
      throw err;
    }
  };
}
