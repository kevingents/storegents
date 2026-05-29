import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { upsertFaqItem, deleteFaqItem } from '../../lib/faq-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
  const token = String(
    req.headers['x-admin-token'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).trim();
  return token === adminToken;
}

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

/**
 * POST /api/admin/faq      → create/update (body: {id?, category, question, answer, relatedModal?})
 * DELETE /api/admin/faq?id → verwijder item
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'DELETE', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'Niet bevoegd.' });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    if (!body.question || !body.answer) {
      return res.status(400).json({ success: false, error: 'Vraag en antwoord zijn verplicht.' });
    }
    try {
      const item = await upsertFaqItem({
        id: body.id,
        category: body.category,
        question: body.question,
        answer: body.answer,
        relatedModal: body.relatedModal
      });
      return res.status(200).json({ success: true, item });
    } catch (error) {
      console.error('[admin/faq POST]', error);
      return res.status(500).json({ success: false, error: error.message || 'FAQ-item opslaan mislukt.' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is verplicht.' });
    try {
      const ok = await deleteFaqItem(id);
      if (!ok) return res.status(404).json({ success: false, error: 'FAQ-item niet gevonden.' });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('[admin/faq DELETE]', error);
      return res.status(500).json({ success: false, error: error.message || 'Verwijderen mislukt.' });
    }
  }

  return res.status(405).json({ success: false, error: 'Alleen POST/DELETE toegestaan.' });
}
