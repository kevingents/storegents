import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getBearerToken, verifyPersonnelSession } from '../../../lib/personnel-session.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  }

  try {
    const employee = verifyPersonnelSession(getBearerToken(req));

    return res.status(200).json({ success: true, employee });
  } catch (error) {
    return res.status(401).json({ success: false, message: error.message || 'Niet ingelogd.' });
  }
}
