/**
 * Admin endpoint voor voorraad-correcties.
 *
 *   GET  /api/admin/stock-corrections
 *        ?status=&store=&from=&to=&report=1
 *
 *        - Zonder report=1: lijst van aanvragen
 *        - Met report=1: aggregatie + lijst
 *
 *   POST /api/admin/stock-corrections
 *        Body: { id, action: 'approve' | 'reject' | 'complete' | 'cancel', note, actor }
 *
 *   GET  /api/admin/stock-corrections?meta=1
 *        Geeft alleen de reden-lijst en mogelijke statussen — handig voor UI dropdowns.
 *
 * Auth: vereist admin-token (ADMIN_TOKEN env, default '12345' voor dev).
 */

import {
  STOCK_CORRECTION_REASONS,
  STOCK_CORRECTION_STATUSES,
  listRequests,
  approveRequest,
  rejectRequest,
  completeRequest,
  cancelRequest,
  aggregateReport,
  getRequestById
} from '../../lib/stock-corrections-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_e) { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v ?? '').trim(); }

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      if (clean(req.query.meta) === '1') {
        return res.status(200).json({
          success: true,
          reasons: STOCK_CORRECTION_REASONS,
          statuses: STOCK_CORRECTION_STATUSES
        });
      }

      const filters = {
        store: clean(req.query.store) || undefined,
        status: clean(req.query.status) || undefined,
        from: clean(req.query.from) || undefined,
        to: clean(req.query.to) || undefined,
        requestedByUserId: clean(req.query.requestedByUserId) || undefined
      };

      if (clean(req.query.id)) {
        const found = await getRequestById(clean(req.query.id));
        if (!found) return res.status(404).json({ success: false, message: 'Aanvraag niet gevonden.' });
        return res.status(200).json({ success: true, request: found });
      }

      if (clean(req.query.report) === '1') {
        const { total, requests } = await aggregateReport({
          from: filters.from,
          to: filters.to,
          store: filters.store
        });
        return res.status(200).json({ success: true, total, requests });
      }

      const requests = await listRequests(filters);
      return res.status(200).json({ success: true, count: requests.length, requests });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const id = clean(body.id);
      const action = clean(body.action).toLowerCase();
      const note = clean(body.note);
      const actor = body.actor || { name: 'admin' };

      if (!id) return res.status(400).json({ success: false, message: 'Aanvraag-id ontbreekt.' });

      let updated;
      switch (action) {
        case 'approve':
          updated = await approveRequest(id, { note }, actor);
          break;
        case 'reject':
          updated = await rejectRequest(id, { note }, actor);
          break;
        case 'complete':
          updated = await completeRequest(id, { note }, actor);
          break;
        case 'cancel':
          updated = await cancelRequest(id, { reason: note }, actor);
          break;
        default:
          return res.status(400).json({ success: false, message: `Onbekende actie "${action}".` });
      }

      return res.status(200).json({ success: true, request: updated });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  } catch (error) {
    console.error('[admin/stock-corrections] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Server-fout.' });
  }
}
