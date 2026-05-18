import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  getCustomerNotesForKey,
  addCustomerNote,
  deleteCustomerNote,
  addCustomerTag,
  deleteCustomerTag,
  setCustomerNewsletterStatus
} from '../../lib/customer-notes-store.js';

/**
 * /api/admin/customer-notes — CRUD voor klant-notities, tags, newsletter status.
 *
 * GET  ?customerKey=email-of-id   → { notes, tags, newsletter }
 * POST { customerKey, action: 'add-note'|'delete-note'|'add-tag'|'delete-tag'|'set-newsletter',
 *        text, author, id, label, color, subscribed }
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return true;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

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

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    if (req.method === 'GET') {
      const key = String(req.query.customerKey || req.query.email || req.query.customerId || '').trim();
      if (!key) return res.status(400).json({ success: false, message: 'customerKey ontbreekt.' });
      const data = await getCustomerNotesForKey(key);
      return res.status(200).json({ success: true, customerKey: key, ...data });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const customerKey = String(body.customerKey || body.email || body.customerId || '').trim();
      const action = String(body.action || '').trim();
      if (!customerKey) return res.status(400).json({ success: false, message: 'customerKey ontbreekt.' });
      if (!action) return res.status(400).json({ success: false, message: 'action ontbreekt.' });

      switch (action) {
        case 'add-note': {
          const note = await addCustomerNote(customerKey, { text: body.text, author: body.author });
          return res.status(200).json({ success: true, note });
        }
        case 'delete-note': {
          if (!body.id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
          const ok = await deleteCustomerNote(customerKey, body.id);
          return res.status(200).json({ success: ok, message: ok ? 'Notitie verwijderd.' : 'Notitie niet gevonden.' });
        }
        case 'add-tag': {
          const tag = await addCustomerTag(customerKey, { label: body.label, color: body.color });
          return res.status(200).json({ success: true, tag });
        }
        case 'delete-tag': {
          if (!body.id) return res.status(400).json({ success: false, message: 'id ontbreekt.' });
          const ok = await deleteCustomerTag(customerKey, body.id);
          return res.status(200).json({ success: ok });
        }
        case 'set-newsletter': {
          const newsletter = await setCustomerNewsletterStatus(customerKey, body.subscribed);
          return res.status(200).json({ success: true, newsletter });
        }
        default:
          return res.status(400).json({ success: false, message: `Onbekende action: ${action}` });
      }
    }

    return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
  } catch (error) {
    console.error('[admin/customer-notes]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onbekende fout.' });
  }
}
