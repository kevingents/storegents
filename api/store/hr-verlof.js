/**
 * GET /api/store/hr-verlof
 *
 * Winkel-versie van het verlof-overzicht: toont ALLEEN hoofdkantoor-medewerkers
 * die in de periode afwezig zijn (naam, afdeling, type, periode). Geen
 * gevoelige velden (notes). Zodat winkels weten wie op kantoor afwezig is.
 *
 *   ?period=week|maand|...|custom[&from=&to=]   (default: week)
 *
 * Read-only, achter de portal-login (geen admin-token nodig — net als andere
 * /api/store endpoints).
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getLeaveOverview, periodToRange } from '../../lib/hr-productivity.js';

export const maxDuration = 30;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    const period = String(req.query.period || 'week');
    const range = periodToRange(period, { from: String(req.query.from || ''), to: String(req.query.to || '') });
    const data = await getLeaveOverview(range);
    const rows = (data.rows || [])
      .filter((r) => r.isOffice)
      .map((r) => ({ name: r.name, from: r.from, to: r.to, type: r.type, department: r.department }));
    return res.status(200).json({ success: true, period, window: data.window, rows, total: rows.length });
  } catch (e) {
    console.error('[store/hr-verlof]', e);
    /* 200 met success:false zodat het winkel-paneel netjes degradeert. */
    return res.status(200).json({ success: false, rows: [], total: 0, message: e.message || 'Onbekende fout.' });
  }
}
