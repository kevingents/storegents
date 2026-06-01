/**
 * GET /api/store/vacancies — publieke open vacatures (voor de website).
 *
 *   ?store=GENTS+Almere   → alleen vacatures van die winkel (voor de winkelpagina)
 *   (zonder store)        → alle open vacatures
 *
 * Open read; alleen publieke velden. Voor de vacaturepagina + per-winkel weergave.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { listVacancies } from '../../lib/recruitment-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=120');

  try {
    const store = String(req.query.store || '');
    const rows = await listVacancies({ status: 'open', store });
    const pub = rows.map((v) => ({
      id: v.id,
      title: v.title,
      store: v.store,
      department: v.department,
      employmentType: v.employmentType,
      hoursPerWeek: v.hoursPerWeek,
      description: v.description,
      requirements: v.requirements
    }));
    return res.status(200).json({ success: true, vacancies: pub, total: pub.length });
  } catch (e) {
    console.error('[store/vacancies]', e);
    return res.status(200).json({ success: false, vacancies: [], total: 0, message: e.message });
  }
}
