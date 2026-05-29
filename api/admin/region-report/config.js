import { getRegionReportConfig, saveRegionReportConfig } from '../../../lib/region-report-config-store.js';
import { getAdminToken } from '../../../lib/gents-mail-config.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const expected = getAdminToken() || String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
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

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  if (req.method === 'GET') {
    const config = await getRegionReportConfig();
    return res.status(200).json({ success: true, config });
  }

  if (req.method === 'POST') {
    try {
      const body = await readBody(req);
      const config = await saveRegionReportConfig(body.config || body);
      return res.status(200).json({ success: true, config });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message || 'Configuratie kon niet worden opgeslagen.' });
    }
  }

  return res.status(405).json({ success: false, message: 'Alleen GET/POST is toegestaan.' });
}
