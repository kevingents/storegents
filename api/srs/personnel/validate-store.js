import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getBearerToken, verifyPersonnelSession } from '../../../lib/personnel-session.js';

function parseBody(req) {
  if (typeof req.body === 'string') {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }

  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  }

  try {
    const employee = verifyPersonnelSession(getBearerToken(req));
    const body = parseBody(req);
    const store = String(body.store || '').trim();

    if (!store) {
      return res.status(400).json({ success: false, message: 'Winkel ontbreekt.' });
    }

    if (!employee.isMasterAdmin && !employee.stores.includes(store)) {
      return res.status(403).json({ success: false, message: 'Deze medewerker heeft geen toegang tot deze winkel.' });
    }

    return res.status(200).json({ success: true, employee, store });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'Niet ingelogd.' });
  }
}
