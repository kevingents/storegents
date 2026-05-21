/**
 * Maak een nieuwe uitwisseling aan in SRS.
 *
 *   POST /api/store/uitwisseling-create
 *     Body: {
 *       vanFiliaal: 10,         // SRS branchId OF
 *       vanStore: 'GENTS Almere',  // store-naam (we resolven branchId)
 *       naarFiliaal: 11,        // OF naarStore
 *       naarStore: 'GENTS Arnhem',
 *       referentie: 'Web aanvraag #42',
 *       regels: [{ barcode: '290...', aantal: 5 }, ...],
 *       requestedBy: { userId, name }  // voor audit
 *     }
 *
 *   Response: { success, status, vanFiliaal, naarFiliaal, regels, srsResponse }
 *
 * Auth: geen admin-token vereist (winkel-medewerkers). Wel rate-limiting:
 *       max N requests per IP per minuut (env: SRS_UITWISSEL_RATE_LIMIT).
 */

import { boekUitwisseling } from '../../lib/srs-uitwisseling-create-client.js';
import { getSrsBranchId } from '../../lib/srs-branches.js';
import { getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import { corsJson, requirePost } from '../../lib/request-guards.js';

/* In-memory rate-limit (per cold-start). Voor productie: vervang door
   shared store, maar voor nu houdt dit de SRS API beschermd tegen mishaps. */
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = Number(process.env.SRS_UITWISSEL_RATE_LIMIT || 20);

function getClientIp(req) {
  return String(
    req.headers['x-real-ip'] ||
    req.headers['x-forwarded-for']?.split(',')[0] ||
    req.socket?.remoteAddress ||
    'unknown'
  ).trim();
}

function checkRateLimit(req) {
  const ip = getClientIp(req);
  const now = Date.now();
  const bucket = rateLimitMap.get(ip) || [];
  const recent = bucket.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) return false;
  recent.push(now);
  rateLimitMap.set(ip, recent);
  /* Cleanup oude entries om memory bound te houden */
  if (rateLimitMap.size > 500) {
    const cutoff = now - RATE_LIMIT_WINDOW_MS;
    for (const [k, v] of rateLimitMap.entries()) {
      const cleaned = v.filter((t) => t > cutoff);
      if (cleaned.length === 0) rateLimitMap.delete(k);
      else rateLimitMap.set(k, cleaned);
    }
  }
  return true;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_e) { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v ?? '').trim(); }

function resolveBranchId(filiaal, store) {
  if (filiaal && Number(filiaal)) return Number(filiaal);
  if (store) {
    try {
      const id = getSrsBranchId(store);
      if (id) return Number(id);
    } catch (_err) { /* onbekende winkel — laat 0 returnen */ }
  }
  return 0;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requirePost(req, res)) return;

  if (!checkRateLimit(req)) {
    return res.status(429).json({ success: false, message: 'Te veel aanvragen, probeer over een minuut opnieuw.' });
  }

  try {
    const body = parseBody(req);

    const vanFiliaal = resolveBranchId(body.vanFiliaal, body.vanStore);
    const naarFiliaal = resolveBranchId(body.naarFiliaal, body.naarStore);
    const referentie = clean(body.referentie);
    const regels = Array.isArray(body.regels) ? body.regels : [];

    if (!vanFiliaal) return res.status(400).json({ success: false, message: 'vanFiliaal (of vanStore) ontbreekt of onbekend.' });
    if (!naarFiliaal) return res.status(400).json({ success: false, message: 'naarFiliaal (of naarStore) ontbreekt of onbekend.' });
    if (vanFiliaal === naarFiliaal) return res.status(400).json({ success: false, message: 'vanFiliaal en naarFiliaal mogen niet gelijk zijn.' });
    if (!regels.length) return res.status(400).json({ success: false, message: 'Geen regels opgegeven.' });

    /* Normaliseer regels client-side */
    const normRegels = regels.map((r, i) => {
      const barcode = clean(r.barcode || r.sku);
      const aantal = Number(r.aantal || r.quantity || 0);
      if (!barcode) throw new Error(`Regel ${i + 1}: barcode is verplicht.`);
      if (!aantal || aantal <= 0) throw new Error(`Regel ${i + 1}: aantal moet > 0 zijn.`);
      return { barcode, aantal };
    });

    const result = await boekUitwisseling({
      vanFiliaal,
      naarFiliaal,
      referentie,
      regels: normRegels
    });

    /* SRS returnt "OK" bij succes — bij andere antwoorden mappen we naar 502. */
    if (!result.success) {
      const isLoginFail = /login.*failed|authentication|not authorized/i.test(result.status || '');
      const helpText = isLoginFail
        ? ` De ingestelde SRS-credentials hebben geen rechten op de boek-uitwisseling endpoint. Configureer in Vercel SRS_UITWISSEL_CREDS_JSON (per-filiaal accounts) of SRS_UITWISSEL_USER + SRS_UITWISSEL_PASSWORD (globaal account met write-rechten).`
        : '';
      return res.status(502).json({
        success: false,
        message: `SRS gaf geen OK terug: "${result.status}".${helpText}`,
        srsStatus: result.status,
        credSource: result.credSource || null,
        vanFiliaal,
        naarFiliaal,
        regels: normRegels
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Uitwisseling aangemaakt in SRS.',
      vanFiliaal,
      naarFiliaal,
      vanStore: getStoreNameByBranchId(vanFiliaal) || `Filiaal ${vanFiliaal}`,
      naarStore: getStoreNameByBranchId(naarFiliaal) || `Filiaal ${naarFiliaal}`,
      referentie,
      regels: normRegels,
      srsStatus: result.status,
      requestedBy: body.requestedBy || null
    });
  } catch (error) {
    console.error('[store/uitwisseling-create]', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Uitwisseling aanmaken mislukt.',
      details: error.fault || null
    });
  }
}
