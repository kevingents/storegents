/**
 * /api/admin/kpis/registry
 *
 * GET    → de complete KPI-registry (defaults + overrides gemerged)
 * PATCH  → update 1 KPI-override (enabled/label/thresholds/inReports)
 *          body: { key, patch: { enabled?, label?, thresholds?, inReports? } }
 * DELETE → reset 1 KPI-override naar default
 *          body: { key }
 *
 * Auth: admin-token vereist.
 */

import {
  readKpiRegistry,
  updateKpiOverride,
  resetKpiOverride,
  KPI_CATEGORIES,
  KPI_UNITS
} from '../../../lib/kpi-registry.js';
import { listSourceKeys } from '../../../lib/kpi-sources/index.js';
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
  if (corsJson(req, res, ['GET', 'PATCH', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const reg = await readKpiRegistry({ forceFresh: true });
      return res.status(200).json({
        success: true,
        kpis: reg.kpis,
        categories: KPI_CATEGORIES,
        units: KPI_UNITS,
        availableSources: listSourceKeys(),
        updatedAt: reg.updatedAt,
        updatedBy: reg.updatedBy
      });
    }

    if (req.method === 'PATCH') {
      const body = parseBody(req);
      const key = String(body.key || '').trim();
      const patch = body.patch || {};
      if (!key) return res.status(400).json({ success: false, message: 'key vereist.' });
      const reg = await updateKpiOverride(key, patch, actorFromReq(req));
      return res.status(200).json({ success: true, kpis: reg.kpis });
    }

    if (req.method === 'DELETE') {
      const body = parseBody(req);
      const key = String(body.key || req.query?.key || '').trim();
      if (!key) return res.status(400).json({ success: false, message: 'key vereist.' });
      const removed = await resetKpiOverride(key, actorFromReq(req));
      const reg = await readKpiRegistry({ forceFresh: true });
      return res.status(200).json({ success: true, removed, kpis: reg.kpis });
    }

    return res.status(405).json({ success: false, message: 'Method niet ondersteund.' });
  } catch (e) {
    console.error('[admin/kpis/registry]', e);
    return res.status(500).json({ success: false, message: e.message || 'Registry-call faalde.' });
  }
}
