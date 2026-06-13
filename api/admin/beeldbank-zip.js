import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { buildImageZip } from '../../lib/beeldbank-zip.js';

/**
 * POST /api/admin/beeldbank-zip   { filename, images: [url] }
 * Bouwt een ZIP van de meegegeven afbeeldingen → Vercel Blob → { url, count, bytes }.
 * De portal opent vervolgens de download-URL.
 */

export const config = { maxDuration: 60 };

function clean(v) { return String(v == null ? '' : v).trim(); }

function isAuthorized(req) {
  const adminToken = clean(process.env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const token = clean(
    req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization ||
    req.query?.adminToken || req.query?.admin_token || ''
  ).replace(/^Bearer\s+/i, '');
  return token === adminToken;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const body = parseBody(req);
  const images = Array.isArray(body.images) ? body.images : [];
  if (!images.length) return res.status(400).json({ success: false, message: 'Geen afbeeldingen meegegeven.' });

  try {
    const zip = await buildImageZip({ filename: clean(body.filename) || 'beeldbank', images });
    return res.status(200).json({ success: true, ...zip });
  } catch (error) {
    console.error('[admin/beeldbank-zip]', error);
    return res.status(200).json({ success: false, message: error.message || 'ZIP maken mislukt.' });
  }
}
