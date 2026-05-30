import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getStoreContact, setStoreContact } from '../../lib/store-contacts-store.js';

/**
 * /api/admin/store-contacts — bewerkbare winkel-contactgegevens.
 *
 * GET  ?store=GENTS Amsterdam   → { success, store, phone, contactName, note,
 *                                   email, address, city }
 * POST { store, phone, contactName, note } → opslaan, geeft bijgewerkte kaart terug
 */

function parseBody(req) {
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const store = String(req.query.store || req.query.name || '').trim();
      if (!store) return res.status(400).json({ success: false, message: 'store ontbreekt.' });
      const contact = await getStoreContact(store);
      return res.status(200).json({ success: true, ...contact });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const store = String(body.store || body.name || '').trim();
      if (!store) return res.status(400).json({ success: false, message: 'store ontbreekt.' });
      const contact = await setStoreContact(store, {
        phone: body.phone,
        contactName: body.contactName,
        note: body.note
      });
      return res.status(200).json({ success: true, ...contact });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
  } catch (error) {
    console.error('[admin/store-contacts]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onbekende fout.' });
  }
}
