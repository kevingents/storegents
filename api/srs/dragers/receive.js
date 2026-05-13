import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { receiveDrager } from '../../../lib/srs-dragers-soap.js';
import { getDragerCache, saveDragerCache } from '../../../lib/srs-dragers-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(410).json({ success: false, message: 'Dragers functie is tijdelijk uitgeschakeld omdat SRS-koppeling nog niet stabiel is.' });
}
