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

/* Extract relevante "wat heeft de cron gedaan"-velden uit de response body.
   Alle top-level numerieke/boolean/short-string velden + nested .summary
   worden opgepikt. Zo verschijnen bv. bol-stock { gepusht, fouten,
   overgeslagen, totaal } automatisch in cron-overzicht zonder per-cron
   wijziging. Skipt grote arrays (resultaten/samples) — alleen counts. */
function extractSummary(body) {
  if (!body || typeof body !== 'object') return null;
  const out = {};
  const SKIP_KEYS = new Set(['resultaten', 'samples', 'config', 'data', 'rows', 'items', 'list', 'newsletters', 'audiences', 'html']);
  const flatten = (obj, prefix = '') => {
    for (const [k, v] of Object.entries(obj || {})) {
      if (SKIP_KEYS.has(k)) continue;
      const key = prefix ? `${prefix}.${k}` : k;
      if (v == null) continue;
      const t = typeof v;
      if (t === 'number' && Number.isFinite(v)) out[key] = v;
      else if (t === 'boolean') out[key] = v;
      else if (t === 'string' && v.length && v.length < 80) out[key] = v;
      else if (k === 'summary' && t === 'object') flatten(v, key);
    }
  };
  flatten(body);
  return Object.keys(out).length ? out : null;
}

export function trackedCron(key, handler) {
  return async function trackedHandler(req, res) {
    const startedAt = Date.now();

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

    /* Capture res.json(body) zodat we counts kunnen extracten zonder dat
       de handler er iets van hoeft te weten. */
    let capturedBody = null;
    const origJson = res.json?.bind(res);
    if (typeof origJson === 'function') {
      res.json = function trackedJson(body) {
        try { capturedBody = body; } catch {}
        return origJson(body);
      };
    }

    try {
      const result = await handler(req, res);
      const durationMs = Date.now() - startedAt;
      const ok = lastHttpStatus >= 200 && lastHttpStatus < 400;
      /* Bij een fout-status: neem de ECHTE foutmelding uit de response-body
         (capturedBody.message) mee, niet alleen "HTTP 500". Anders ziet de admin
         in het cron-overzicht enkel de status-code en niet de oorzaak. */
      const bodyMsg = (!ok && capturedBody && typeof capturedBody === 'object' && capturedBody.message) ? String(capturedBody.message) : '';
      await recordCronRun(key, {
        status: ok ? 'success' : (lastHttpStatus === 207 ? 'partial' : 'failed'),
        durationMs,
        error: ok ? '' : (bodyMsg ? `HTTP ${lastHttpStatus}: ${bodyMsg}` : `HTTP ${lastHttpStatus}`).slice(0, 500),
        summary: extractSummary(capturedBody)
      }).catch((e) => console.warn(`[cron-auto-track] recordCronRun faalde voor ${key}:`, e.message));
      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      await recordCronRun(key, {
        status: 'failed',
        durationMs,
        error: String(err?.message || err || 'onbekend').slice(0, 500),
        summary: extractSummary(capturedBody)
      }).catch((e) => console.warn(`[cron-auto-track] recordCronRun faalde voor ${key}:`, e.message));
      throw err;
    }
  };
}
