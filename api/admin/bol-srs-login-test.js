/**
 * POST /api/admin/bol-srs-login-test
 *
 * Test ALLEEN of een SRS-weborder-login lukt voor een gegeven user — er wordt
 * GEEN order geplaatst. Bedoeld om de juiste Bol-user (bv. Bol_1088) + wachtwoord
 * te vinden zonder steeds dubbele SRS-orders aan te maken.
 *
 * Body (JSON): { user: "Bol_1088" }
 *   - user / weborderUser : de SRS-login om te testen.
 *
 * Wachtwoord komt NOOIT uit de request: srsApiLoginAs gebruikt
 * SRS_BOL_API_PASSWORD (Vercel-env) indien gezet, anders het hoofd-wachtwoord.
 *
 * Auth: admin-token (header x-admin-token).
 */

import { corsJson, requireAdmin } from '../../lib/request-guards.js';
import { srsApiLoginAs } from '../../lib/srs-weborder-client.js';

const clean = (v) => String(v == null ? '' : v).trim();

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const body = (req.body && typeof req.body === 'object') ? req.body : {};
  const user = clean(body.user || body.weborderUser);
  const usedBolPassword = Boolean(process.env.SRS_BOL_API_PASSWORD);

  if (!user) {
    return res.status(400).json({ success: false, message: 'Geef "user" mee (de SRS-login om te testen).' });
  }

  try {
    const sessionId = await srsApiLoginAs(user);
    return res.status(200).json({
      success: true,
      ok: true,
      user,
      usedBolPassword,
      sessionPrefix: `${String(sessionId).slice(0, 6)}…`,
      message: `Login GELUKT als "${user}"${usedBolPassword ? ' (met SRS_BOL_API_PASSWORD)' : ' (met hoofd-wachtwoord)'}.`
    });
  } catch (e) {
    return res.status(200).json({
      success: true,
      ok: false,
      user,
      usedBolPassword,
      message: `Login MISLUKT als "${user}"${usedBolPassword ? ' (met SRS_BOL_API_PASSWORD)' : ' (met hoofd-wachtwoord)'}: ${e.message || e}`
    });
  }
}
