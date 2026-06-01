/**
 * /api/admin/hr/vacancies — vacature-beheer (HR).
 *
 *   GET    [?id= | ?status= | ?store=]   → 1 vacature of lijst
 *   POST   body: vacature (met id = update, zonder id = nieuw)
 *   DELETE ?id=
 *
 * Auth: admin-token vereist.
 */

import { listVacancies, getVacancy, upsertVacancy, deleteVacancy } from '../../../lib/recruitment-store.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      if (req.query.id) return res.status(200).json({ success: true, vacancy: await getVacancy(req.query.id) });
      const rows = await listVacancies({ status: String(req.query.status || ''), store: String(req.query.store || '') });
      return res.status(200).json({ success: true, vacancies: rows });
    }
    if (req.method === 'POST') {
      const v = await upsertVacancy(parseBody(req), String(req.headers['x-actor'] || 'admin'));
      return res.status(200).json({ success: true, vacancy: v });
    }
    if (req.method === 'DELETE') {
      const id = String(req.query.id || '');
      if (!id) return res.status(400).json({ success: false, message: 'id vereist.' });
      return res.status(200).json({ success: true, removed: await deleteVacancy(id) });
    }
    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/hr/vacancies]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
