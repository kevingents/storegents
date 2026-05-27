/**
 * /api/admin/kpis/targets
 *
 * GET    ?year=2026&month=5
 *          → targets voor 1 maand: { stores: { storeName: { kpi_key: value } } }
 *        (zonder params: alle maanden)
 *
 * POST   body: { year, month, store, kpi, value }
 *          → set 1 target (value=null verwijdert)
 *        OF bulk: { year, month, store, kpiValues: { kpi_key: value, ... } }
 *          → vervang complete row voor (store, maand)
 *
 * DELETE ?year=2026&month=5&store=...&kpi=...
 *          → verwijder 1 specifieke target
 *
 * Auth: admin-token vereist.
 */

import {
  getTargetsForMonth,
  setTarget,
  setTargetsForStore,
  listMonthsWithTargets
} from '../../../lib/kpi-targets-store.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function actorFromReq(req) {
  return String(req.headers?.['x-actor'] || req.headers?.['x-user-email'] || 'admin');
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const year = req.query?.year;
      const month = req.query?.month;
      if (year && month) {
        const stores = await getTargetsForMonth(year, month);
        return res.status(200).json({ success: true, year: Number(year), month: Number(month), stores });
      }
      const months = await listMonthsWithTargets();
      return res.status(200).json({ success: true, months });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const { year, month, store } = body;
      if (!year || !month) {
        return res.status(400).json({ success: false, message: 'year + month vereist.' });
      }
      const actor = actorFromReq(req);

      /* Bulk-mode: setTargetsForStore */
      if (body.kpiValues && typeof body.kpiValues === 'object') {
        const updated = await setTargetsForStore(year, month, store, body.kpiValues, actor);
        return res.status(200).json({ success: true, stores: updated });
      }

      /* Single-mode: setTarget */
      const { kpi, value } = body;
      if (!kpi) return res.status(400).json({ success: false, message: 'kpi vereist.' });
      const updated = await setTarget(year, month, store, kpi, value, actor);
      return res.status(200).json({ success: true, stores: updated });
    }

    if (req.method === 'DELETE') {
      const { year, month, store, kpi } = req.query || {};
      if (!year || !month || !kpi) {
        return res.status(400).json({ success: false, message: 'year + month + kpi vereist.' });
      }
      const updated = await setTarget(year, month, store, kpi, null, actorFromReq(req));
      return res.status(200).json({ success: true, stores: updated });
    }

    return res.status(405).json({ success: false, message: 'Method niet ondersteund.' });
  } catch (e) {
    console.error('[admin/kpis/targets]', e);
    return res.status(500).json({ success: false, message: e.message || 'Targets-call faalde.' });
  }
}
