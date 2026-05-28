/**
 * GET /api/admin/spotler-test
 *
 * Verifieert de Spotler/MailPlus OAuth 1.0a-verbinding en toont de datavorm
 * van een paar resources, zodat we de echte velden kennen voordat we de
 * metrics-/audience-features bouwen. Doet alleen veilige GET-calls.
 *
 * Optioneel: ?path=mailing&pageSize=1  → test een specifiek pad.
 * Auth: admin-token vereist.
 */

import { spotlerRequest, hasSpotlerCreds } from '../../lib/spotler-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* Compacte beschrijving van een respons: type, lengte, en sleutels van het 1e item. */
function summarize(d) {
  if (d == null) return { type: 'null' };
  if (Array.isArray(d)) return { type: 'array', length: d.length, firstKeys: d[0] && typeof d[0] === 'object' ? Object.keys(d[0]).slice(0, 40) : undefined, first: d[0] };
  if (typeof d === 'object') {
    const out = { type: 'object', keys: Object.keys(d).slice(0, 40) };
    for (const k of Object.keys(d)) {
      if (Array.isArray(d[k])) { out.arrayKey = k; out.arrayLen = d[k].length; out.itemKeys = d[k][0] && typeof d[k][0] === 'object' ? Object.keys(d[k][0]).slice(0, 40) : undefined; out.firstItem = d[k][0]; break; }
    }
    return out;
  }
  return { type: typeof d, value: String(d).slice(0, 200) };
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (!hasSpotlerCreds()) {
    return res.status(200).json({ success: false, connected: false, message: 'SPOTLER_CONSUMER_KEY / SPOTLER_CONSUMER_SECRET ontbreken in Vercel.' });
  }

  /* Specifiek pad testen via ?path=… */
  const customPath = String(req.query?.path || '').trim();
  if (customPath) {
    const pageSize = String(req.query?.pageSize || '5');
    try {
      const d = await spotlerRequest('GET', customPath, { query: { pageSize } });
      return res.status(200).json({ success: true, connected: true, path: customPath, summary: summarize(d), raw: d });
    } catch (e) {
      return res.status(200).json({ success: false, connected: false, path: customPath, status: e.status || 0, error: e.message, body: e.body });
    }
  }

  /* Standaard: probeer een paar bekende resources (eerste die lukt bevestigt auth). */
  const probes = ['templist', 'mailing', 'contact', 'audience'];
  const checks = {};
  let connected = false;
  for (const p of probes) {
    try {
      const d = await spotlerRequest('GET', p, { query: { pageSize: '1' } });
      checks[p] = { ok: true, summary: summarize(d) };
      connected = true;
    } catch (e) {
      checks[p] = { ok: false, status: e.status || 0, error: e.message };
    }
  }

  return res.status(200).json({
    success: true,
    connected,
    hint: connected ? 'Auth werkt. Gebruik ?path=<resource> om een specifieke resource te bekijken.' : 'Geen enkele call lukte — controleer key/secret en of de REST API in MailPlus aanstaat.',
    checks
  });
}
