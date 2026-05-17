import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { upsertFunctionHelpItem, deleteFunctionHelpItem } from '../../lib/function-help-store.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
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

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'DELETE', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'DELETE', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, error: 'Niet bevoegd.' });
  }

  if (req.method === 'POST') {
    const body = parseBody(req);
    if (!body.title || !body.description) {
      return res.status(400).json({ success: false, error: 'Titel en omschrijving zijn verplicht.' });
    }
    try {
      const item = await upsertFunctionHelpItem({
        id: body.id,
        icon: body.icon,
        title: body.title,
        description: body.description,
        modalId: body.modalId,
        order: body.order
      });
      return res.status(200).json({ success: true, item });
    } catch (error) {
      console.error('[admin/function-help POST]', error);
      return res.status(500).json({ success: false, error: error.message || 'Function help opslaan mislukt.' });
    }
  }

  if (req.method === 'DELETE') {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ success: false, error: 'id is verplicht.' });
    try {
      const ok = await deleteFunctionHelpItem(id);
      if (!ok) return res.status(404).json({ success: false, error: 'Item niet gevonden.' });
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('[admin/function-help DELETE]', error);
      return res.status(500).json({ success: false, error: error.message || 'Verwijderen mislukt.' });
    }
  }

  return res.status(405).json({ success: false, error: 'Alleen POST/DELETE toegestaan.' });
}
