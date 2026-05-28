/**
 * /api/admin/beeldbank-classify
 *
 * Beeldherkenning voor de beeldbank ("Met model / sfeerbeeld").
 *   GET  → status: { total, classified, remaining, withModel, updatedAt }
 *   POST → classificeer een begrensde batch (body { limit }) via Claude vision.
 *
 * Gefaseerd zodat één call binnen de functielimiet blijft; de rest gebeurt via
 * de dagelijkse cron of door de knop nogmaals te klikken.
 *
 * Auth: admin-token vereist.
 */

import { classifyBatch, getModelStatus } from '../../lib/beeldbank-vision.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

/* Vision-calls duren elk een paar seconden — ruime functielimiet. */
export const maxDuration = 60;

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const status = await getModelStatus();
      return res.status(200).json({ success: true, ...status });
    }

    const body = parseBody(req);
    const limit = Math.max(1, Math.min(20, parseInt(body.limit, 10) || 12));
    const force = body.force === true || body.force === '1';
    const result = await classifyBatch({ limit, force });
    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('[admin/beeldbank-classify]', e);
    return res.status(500).json({ success: false, message: e.message || 'Classificatie mislukt.' });
  }
}
