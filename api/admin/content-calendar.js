/**
 * GET /api/admin/content-calendar
 *
 * Geeft de gecachte content-tips + weer + AI-contentplan terug (snel). Met
 * ?refresh=1 wordt live opnieuw gegenereerd (weer + verkoop + AI). De cron
 * houdt de cache dagelijks warm.
 *
 * Auth: admin-token vereist.
 */

import { readContentCalendar, refreshContentCalendar } from '../../lib/content-calendar.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (String(req.query?.refresh || '') === '1') {
      const data = await refreshContentCalendar();
      return res.status(200).json({ success: true, ...data });
    }
    const cached = await readContentCalendar();
    if (cached) return res.status(200).json({ success: true, ...cached });
    /* Geen cache → niet inline genereren (weer+AI is traag); UI toont Ververs. */
    return res.status(200).json({ success: true, stale: true, weather: [], tips: [], aiPlan: '', sales: { topStores: [], topProducts: [] }, generatedAt: null });
  } catch (e) {
    console.error('[admin/content-calendar]', e);
    return res.status(500).json({ success: false, message: e.message || 'Content-kalender mislukt.' });
  }
}
