/**
 * Klanten-targets beheer per maand per winkel.
 *
 *   GET  /api/admin/customer-targets
 *        ?year=2026&month=5   → targets voor 1 maand: { stores: {storeName: target} }
 *        ?year=2026          → alle maanden in jaar: { months: {month: stores} }
 *        (geen params)       → alle targets
 *
 *   POST /api/admin/customer-targets
 *        Body: { year, month, store, inschrijvingen, metBon, metEmail }
 *        OF bulk: { year, month, targets: { storeName: { inschrijvingen, metBon, metEmail } } }
 *
 *   DELETE /api/admin/customer-targets?year=2026&month=5&store=...
 *
 * Auth: admin-token vereist.
 */

import {
  readAllTargets,
  getTargetsForMonth,
  upsertTarget,
  bulkUpsertMonth,
  deleteTarget
} from '../../lib/customer-targets-store.js';
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
  if (corsJson(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const year = Number(req.query.year) || null;
      const month = Number(req.query.month) || null;
      if (year && month) {
        const stores = await getTargetsForMonth(year, month);
        return res.status(200).json({ success: true, year, month, stores });
      }
      if (year) {
        const all = await readAllTargets();
        const months = {};
        Object.entries(all).forEach(([key, stores]) => {
          if (key.startsWith(`${year}-`)) months[key] = stores;
        });
        return res.status(200).json({ success: true, year, months });
      }
      const all = await readAllTargets();
      return res.status(200).json({ success: true, all });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const year = Number(body.year);
      const month = Number(body.month);
      const actor = clean(req.headers['x-actor'] || body.actor) || 'admin';
      if (!year || !month) return res.status(400).json({ success: false, message: 'year en month zijn verplicht.' });

      /* Bulk-mode: hele maand in 1 call */
      if (body.targets && typeof body.targets === 'object') {
        const updated = await bulkUpsertMonth(year, month, body.targets, actor);
        return res.status(200).json({ success: true, year, month, stores: updated });
      }

      /* Single-mode: 1 winkel */
      const store = clean(body.store);
      if (!store) return res.status(400).json({ success: false, message: 'store of targets verplicht.' });
      const updated = await upsertTarget(year, month, store, {
        inschrijvingen: body.inschrijvingen,
        metBon: body.metBon,
        metEmail: body.metEmail
      }, actor);
      return res.status(200).json({ success: true, year, month, store, target: updated });
    }

    if (req.method === 'DELETE') {
      const year = Number(req.query.year);
      const month = Number(req.query.month);
      const store = clean(req.query.store);
      if (!year || !month || !store) return res.status(400).json({ success: false, message: 'year, month en store verplicht.' });
      const removed = await deleteTarget(year, month, store);
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/customer-targets]', error);
    return res.status(500).json({ success: false, message: error.message || 'Server-fout.' });
  }
}
