import {
  getSupportTemplates,
  saveSupportTemplates,
  upsertSupportTemplate,
  deleteSupportTemplate
} from '../../lib/support-templates-store.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAdmin(req) {
  const expected = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

/**
 * /api/admin/support-templates
 *   GET           - lijst alle templates (admin-only)
 *   POST          - body: { template: {...} } -> upsert
 *                   body: { templates: [...] } -> volledige replace
 *   DELETE ?id=X  - verwijder template
 */
export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAdmin(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  try {
    if (req.method === 'GET') {
      const templates = await getSupportTemplates();
      return res.status(200).json({ success: true, templates });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      let templates;
      if (Array.isArray(body.templates)) {
        templates = await saveSupportTemplates(body.templates);
      } else if (body.template && typeof body.template === 'object') {
        templates = await upsertSupportTemplate(body.template);
      } else {
        return res.status(400).json({ success: false, message: 'Geef "template" of "templates" mee in body.' });
      }
      return res.status(200).json({ success: true, templates });
    }

    if (req.method === 'DELETE') {
      const id = String(req.query.id || '').trim();
      if (!id) return res.status(400).json({ success: false, message: 'id is verplicht.' });
      const templates = await deleteSupportTemplate(id);
      return res.status(200).json({ success: true, templates });
    }

    return res.status(405).json({ success: false, message: 'Alleen GET/POST/DELETE.' });
  } catch (error) {
    console.error('[admin/support-templates]', error);
    return res.status(500).json({ success: false, message: error.message || 'Templates fout.' });
  }
}
