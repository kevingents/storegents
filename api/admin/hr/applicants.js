/**
 * /api/admin/hr/applicants — sollicitanten (HR).
 *
 *   GET  [?id= | ?vacancyId= | ?status= | ?store=]  → 1 sollicitant of lijst
 *        (lijst geeft ook newCount voor de menu-badge)
 *   POST body: { id, status?, rating?, notes?, screening? }  → bijwerken
 *
 * Auth: admin-token vereist.
 */

import { listApplicants, getApplicant, updateApplicant, countNewApplicants } from '../../../lib/recruitment-store.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      if (req.query.id) return res.status(200).json({ success: true, applicant: await getApplicant(req.query.id) });
      const rows = await listApplicants({
        vacancyId: String(req.query.vacancyId || ''),
        status: String(req.query.status || ''),
        store: String(req.query.store || '')
      });
      return res.status(200).json({ success: true, applicants: rows, newCount: await countNewApplicants() });
    }
    if (req.method === 'POST') {
      const body = parseBody(req);
      if (!body.id) return res.status(400).json({ success: false, message: 'id vereist.' });
      const a = await updateApplicant(body.id, body, String(req.headers['x-actor'] || 'admin'));
      if (!a) return res.status(404).json({ success: false, message: 'Sollicitant niet gevonden.' });
      return res.status(200).json({ success: true, applicant: a });
    }
    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (e) {
    console.error('[admin/hr/applicants]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
