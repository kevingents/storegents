/**
 * Store endpoint voor voorraad-correcties.
 *
 *   GET  /api/store/stock-corrections?store=GENTS+Arnhem&status=pending
 *        Lijst aanvragen voor één winkel. Filterbaar op status.
 *
 *   POST /api/store/stock-corrections
 *        Body: { action: 'create' | 'cancel', ... }
 *
 *        action=create:
 *          { store, articles[], note, requestedBy: { userId, name } }
 *        action=cancel:
 *          { id, reason }
 *
 * Auth: deze endpoints gebruiken geen admin-token (winkel-medewerkers).
 *       Cancellation: enkel door dezelfde aanvrager OF admin.
 */

import {
  createRequest,
  listRequests,
  getRequestById,
  cancelRequest
} from '../../lib/stock-corrections-store.js';
import { corsJson } from '../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_e) { return {}; }
  }
  return req.body || {};
}

function clean(v) { return String(v ?? '').trim(); }

function isAdminToken(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(req.headers['x-admin-token'] || req.query.adminToken || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken) && given === adminToken;
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;

  try {
    if (req.method === 'GET') {
      const store = clean(req.query.store);
      const status = clean(req.query.status);
      const from = clean(req.query.from);
      const to = clean(req.query.to);
      if (!store) return res.status(400).json({ success: false, message: 'Parameter "store" is verplicht.' });

      const requests = await listRequests({
        store,
        status: status || undefined,
        from: from || undefined,
        to: to || undefined
      });
      return res.status(200).json({ success: true, store, count: requests.length, requests });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const action = clean(body.action) || 'create';

      if (action === 'create') {
        const store = clean(body.store);
        const articles = Array.isArray(body.articles) ? body.articles : [];
        const note = clean(body.note);
        const bestemming = clean(body.bestemming);
        const requestedBy = body.requestedBy || body.actor || { name: 'onbekend' };

        if (!store) return res.status(400).json({ success: false, message: 'Geen winkel opgegeven.' });
        if (!articles.length) return res.status(400).json({ success: false, message: 'Geen artikelen opgegeven.' });

        const created = await createRequest({ store, articles, note, bestemming }, requestedBy);
        return res.status(200).json({ success: true, request: created });
      }

      if (action === 'cancel') {
        const id = clean(body.id);
        const reason = clean(body.reason);
        const actor = body.actor || body.requestedBy || { name: 'onbekend' };
        if (!id) return res.status(400).json({ success: false, message: 'Aanvraag-id ontbreekt.' });

        /* Alleen aanvrager of admin mag annuleren. */
        const request = await getRequestById(id);
        if (!request) return res.status(404).json({ success: false, message: 'Aanvraag niet gevonden.' });
        const isOwner = clean(actor.userId) && clean(actor.userId) === clean(request.requestedBy?.userId);
        if (!isOwner && !isAdminToken(req)) {
          return res.status(403).json({ success: false, message: 'Alleen de aanvrager of een admin kan annuleren.' });
        }

        const updated = await cancelRequest(id, { reason }, actor);
        return res.status(200).json({ success: true, request: updated });
      }

      return res.status(400).json({ success: false, message: `Onbekende actie "${action}".` });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  } catch (error) {
    console.error('[store/stock-corrections] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Server-fout.' });
  }
}
