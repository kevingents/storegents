import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import {
  readAllDeals,
  upsertDeal,
  deleteDeal,
  getDealById
} from '../../lib/vereniging-deals-store.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';
import { readVerenigingMap } from '../../lib/students-vereniging-store.js';
import { listAllBranches } from '../../lib/branch-metrics.js';

/**
 * /api/admin/vereniging-deals
 *
 * GET    → { success, deals, verenigingen, stores }
 *           Inclusief verenigingen-lijst (uit vereniging-cache) + stores lijst
 *           voor dropdowns in admin UI.
 *
 * POST   → upsert deal. Body: {id?, vereniging, title, startDate, endDate, ...}
 *
 * DELETE → ?id=XXX
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'DELETE', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const deals = await readAllDeals();
      /* Verenigingen uit cache halen voor dropdown */
      let verenigingen = [];
      try {
        const map = await readVerenigingMap();
        const set = new Set();
        for (const c of Object.values(map.customers || {})) {
          if (c.vereniging) set.add(c.vereniging);
        }
        verenigingen = Array.from(set).sort();
      } catch (_) {}
      /* Stores uit branch-metrics */
      let stores = [];
      try {
        stores = (listAllBranches() || []).map((b) => b.store).filter(Boolean).sort();
      } catch (_) {}
      return res.status(200).json({
        success: true,
        deals: deals.sort((a, b) => String(b.startDate || '').localeCompare(String(a.startDate || ''))),
        verenigingen,
        stores
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const actor = clean(req.headers['x-actor'] || body.actor || 'admin') || 'admin';
      const existing = body.id ? await getDealById(body.id) : null;
      const updated = await upsertDeal(body, actor);
      await appendAuditEntry({
        actor,
        action: existing ? 'update-deal' : 'create-deal',
        targetUserId: updated.id,
        targetName: `${updated.vereniging} · ${updated.title}`,
        before: existing,
        after: updated
      }).catch(() => {});
      return res.status(200).json({ success: true, deal: updated });
    }

    if (req.method === 'DELETE') {
      const id = clean(req.query.id);
      if (!id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
      const before = await getDealById(id);
      const removed = await deleteDeal(id);
      if (removed) {
        await appendAuditEntry({
          actor: clean(req.headers['x-actor'] || 'admin') || 'admin',
          action: 'delete-deal',
          targetUserId: id,
          targetName: before ? `${before.vereniging} · ${before.title}` : id,
          before
        }).catch(() => {});
      }
      return res.status(200).json({ success: true, removed });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/vereniging-deals]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
