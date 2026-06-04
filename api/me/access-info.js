/**
 * GET /api/me/access-info
 *
 * Publiek diagnose-endpoint (geen auth nodig) dat zegt:
 *   - Vanuit welk IP je komt
 *   - Welke winkel daarbij hoort (of null)
 *   - Of je in een user-whitelist staat
 *   - Of je admin-token in request hebt
 *
 * Bedoeld voor:
 *   1. Login-pagina: laat zien "Vanaf {ip} = {store}, automatisch toegang" of
 *      "Onbekend IP — vul personeelsnummer + kassacode in".
 *   2. Self-service troubleshoot: medewerker kan zien wat zijn IP is om te
 *      vragen het op de whitelist te zetten.
 *   3. Admin-debug bij onverwachte toegangsproblemen.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { resolveAccess } from '../../lib/access-check.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const access = await resolveAccess(req);
  return res.status(200).json({
    success: true,
    access,
    headers: {
      'x-vercel-forwarded-for': req.headers['x-vercel-forwarded-for'] || null,
      'x-forwarded-for': req.headers['x-forwarded-for'] || null,
      'x-real-ip': req.headers['x-real-ip'] || null
    }
  });
}
