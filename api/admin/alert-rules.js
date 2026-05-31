/**
 * /api/admin/alert-rules
 *   GET  ?owner=<id>                 → regels van die eigenaar (of alle bij geen owner)
 *   POST { ...rule, owner, ownerEmail, ownerStores }  → maak/werk bij
 *   POST { op:'toggle', id, actief }
 *   POST { op:'delete', id }
 *
 * Slimme alerts (whitelist-gevalideerd). Auth: admin-token vereist.
 */

import { listRules, upsertRule, setRuleActive, deleteRule } from '../../lib/alert-rules-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  try {
    if (req.method === 'GET') {
      const owner = String(req.query.owner || '').trim();
      const rules = await listRules({ owner });
      return res.status(200).json({ success: true, rules });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (body.op === 'delete') {
        if (!body.id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
        await deleteRule(String(body.id));
        return res.status(200).json({ success: true });
      }
      if (body.op === 'toggle') {
        if (!body.id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
        await setRuleActive(String(body.id), body.actief !== false);
        return res.status(200).json({ success: true });
      }
      const ctx = {
        owner: String(body.owner || '').trim() || 'admin',
        ownerEmail: String(body.ownerEmail || '').trim(),
        ownerStores: Array.isArray(body.ownerStores) ? body.ownerStores : (body.ownerStore ? [body.ownerStore] : [])
      };
      const saved = await upsertRule(body, ctx);
      return res.status(200).json({ success: true, rule: saved });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  } catch (error) {
    console.error('[admin/alert-rules]', error);
    return res.status(500).json({ success: false, message: error.message || 'Alert-regels mislukt.' });
  }
}
