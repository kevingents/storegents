/**
 * GET /api/admin/srs-diagnose
 *
 * Controleert of SRS-credentials werken voor de si_weborder webservice
 * (deze gebruiken we voor reserveringen). Doet een Login-call en
 * rapporteert duidelijk wat er werkt en wat niet.
 *
 * Auth: admin-token verplicht.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { srsApiLogin, invalidateSrsWeborderSession } from '../../lib/srs-weborder-client.js';

function isAuthorized(req) {
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const checks = {
    env: {
      SRS_API_USER: Boolean(process.env.SRS_API_USER || process.env.SRS_API_USERNAME),
      SRS_API_USERNAME: Boolean(process.env.SRS_API_USERNAME),
      SRS_API_PASSWORD: Boolean(process.env.SRS_API_PASSWORD),
      SRS_API_BASE_URL: process.env.SRS_API_BASE_URL || process.env.SRS_BASE_URL || 'https://ws.srs.nl (default)',
      SRS_MESSAGE_USER: Boolean(process.env.SRS_MESSAGE_USER || process.env.srs_message_user),
      SRS_MESSAGE_PASSWORD: Boolean(process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password)
    }
  };

  /* Stap 1: env-check */
  if (!checks.env.SRS_API_USER || !checks.env.SRS_API_PASSWORD) {
    return res.status(200).json({
      success: false,
      stage: 'env-check',
      message: `SRS API credentials ontbreken in Vercel env: ${!checks.env.SRS_API_USER ? 'SRS_API_USER ' : ''}${!checks.env.SRS_API_PASSWORD ? 'SRS_API_PASSWORD' : ''}`.trim(),
      checks,
      next: 'Voeg de ontbrekende env-vars toe in Vercel project settings → Environment Variables, redeploy daarna.'
    });
  }

  /* Stap 2: probeer SOAP-login */
  invalidateSrsWeborderSession(); /* forceer verse login */
  try {
    const startedAt = Date.now();
    const sessionId = await srsApiLogin();
    const durationMs = Date.now() - startedAt;
    return res.status(200).json({
      success: true,
      stage: 'login-ok',
      message: 'SRS si_weborder login gelukt — credentials kloppen, weborders kunnen worden geplaatst.',
      checks,
      session: {
        sessionId: sessionId.slice(0, 8) + '...' + sessionId.slice(-4),
        durationMs
      }
    });
  } catch (error) {
    return res.status(200).json({
      success: false,
      stage: 'login-fail',
      message: `SRS si_weborder login faalde: ${error.message}`,
      checks,
      error: {
        message: error.message,
        status: error.status,
        fault: error.fault,
        responseText: String(error.responseText || '').slice(0, 1500)
      },
      next: 'Controleer SRS_API_USER en SRS_API_PASSWORD waarden in Vercel. Of vraag SRS support of de credentials geactiveerd zijn voor si_weborder webservice.'
    });
  }
}
