import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import {
  getPrizes,
  setPrizes,
  addPrize,
  updatePrize,
  deletePrize,
  computeTotalPot
} from '../../../lib/wk-poule-store.js';

/**
 * /api/admin/wk-poule/prizes
 *
 * GET    → { success, prizes, totalPot }
 *           Geeft de huidige prijzenlijst + berekende totale pot terug.
 *
 * POST   → multi-action endpoint. Body bevat `action`:
 *           { action:'replace-all', items, manualPotOverride, notes }
 *               → vervangt volledige prijzenlijst (single save)
 *           { action:'create', item: {...} }
 *               → voegt 1 prijs toe
 *           { action:'update', id, patch: {...} }
 *               → muteert 1 prijs
 *           { action:'delete', id }
 *               → verwijdert 1 prijs
 *
 * Auth: vereist x-admin-token header met ADMIN_TOKEN.
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
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const prizes = await getPrizes();
      return res.status(200).json({
        success: true,
        prizes,
        totalPot: computeTotalPot(prizes)
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const action = clean(body.action) || 'replace-all';
      const actor = clean(req.headers['x-actor'] || body.actor || 'admin') || 'admin';

      let prizes;
      if (action === 'replace-all') {
        prizes = await setPrizes({
          items: Array.isArray(body.items) ? body.items : [],
          manualPotOverride: body.manualPotOverride,
          notes: body.notes
        }, actor);
      } else if (action === 'create') {
        if (!body.item || typeof body.item !== 'object') {
          return res.status(400).json({ success: false, message: 'item ontbreekt.' });
        }
        prizes = await addPrize(body.item, actor);
      } else if (action === 'update') {
        const id = clean(body.id);
        if (!id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
        if (!body.patch || typeof body.patch !== 'object') {
          return res.status(400).json({ success: false, message: 'patch ontbreekt.' });
        }
        prizes = await updatePrize(id, body.patch, actor);
      } else if (action === 'delete') {
        const id = clean(body.id);
        if (!id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
        prizes = await deletePrize(id, actor);
      } else {
        return res.status(400).json({ success: false, message: `Onbekende action: ${action}` });
      }

      return res.status(200).json({
        success: true,
        prizes,
        totalPot: computeTotalPot(prizes)
      });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  } catch (error) {
    console.error('[admin/wk-poule/prizes]', error);
    return res.status(500).json({ success: false, message: error.message || 'Prijzen-fout.' });
  }
}
