import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { receiveDrager } from '../../../lib/srs-dragers-soap.js';
import { getDragerCache, saveDragerCache } from '../../../lib/srs-dragers-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  if (requireAdmin(req, res)) return;

  try {
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const dragerId = String(body.dragerId || body.id || req.query.dragerId || '').trim();
    const store = String(body.store || req.query.store || '').trim();
    const branchId = String(body.branchId || req.query.branchId || '').trim();
    const employee = String(body.employee || body.employeeName || '').trim();

    const result = await receiveDrager({ dragerId, store, branchId, employee });
    const cache = await getDragerCache();
    await saveDragerCache(cache.filter((row) => String(row.dragerId || row.id) !== dragerId));

    return res.status(200).json({ success: true, dragerId, store, result });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Drager kon niet worden binnengemeld.' });
  }
}
