/**
 * POST /api/admin/hq-bot   { question, personnelId, allowedStores }
 *
 * GENTS HQ-bot — Claude-assistent over de portal-data, READ-ONLY en
 * permissie-gescoped (rol bepaalt server-side welke tools/winkels). Voert geen
 * code uit en wijzigt niets.
 *
 * Auth: admin-token vereist.
 */

import { askHqBot } from '../../lib/hq-bot.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 45;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  try {
    const body = parseBody(req);
    const result = await askHqBot({
      question: body.question,
      personnelId: body.personnelId || body.employeeId || body.userId || '',
      allowedStores: Array.isArray(body.allowedStores) ? body.allowedStores : [],
      role: body.role || ''
    });
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    console.error('[admin/hq-bot]', error);
    return res.status(500).json({ success: false, message: error.message || 'HQ-bot mislukt.' });
  }
}
