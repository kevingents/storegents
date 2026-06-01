/**
 * POST /api/store/cv-upload — CV-upload voor sollicitaties (vanaf de website).
 *
 * Body (JSON): { filename, contentType, dataBase64 }
 *   dataBase64 = base64 van het bestand (met of zonder data:-prefix).
 *
 * Slaat op in Vercel Blob (hr/cv/…) met onraadbare key en geeft de URL terug,
 * die daarna met /api/store/apply als cvUrl wordt meegestuurd.
 *
 * AVG: CV's bevatten persoonsgegevens. De blob-URL is onraadbaar (random key);
 * voor productie is private storage / signed URLs + bewaartermijn aan te raden.
 */

import { put } from '@vercel/blob';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

const ALLOWED = [
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/jpeg', 'image/png'
];
const MAX_BYTES = 5 * 1024 * 1024;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  try {
    const { filename, contentType, dataBase64 } = parseBody(req);
    if (!dataBase64) return res.status(400).json({ success: false, message: 'Geen bestand ontvangen.' });
    const ct = String(contentType || 'application/octet-stream');
    if (!ALLOWED.includes(ct)) return res.status(400).json({ success: false, message: 'Alleen PDF, Word of een afbeelding (JPG/PNG).' });

    const buf = Buffer.from(String(dataBase64).replace(/^data:[^;]+;base64,/, ''), 'base64');
    if (!buf.length) return res.status(400).json({ success: false, message: 'Leeg bestand.' });
    if (buf.length > MAX_BYTES) return res.status(400).json({ success: false, message: 'Bestand te groot (max 5 MB).' });

    const safe = String(filename || 'cv').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'cv';
    const key = `hr/cv/${Date.now()}-${Math.random().toString(36).slice(2, 10)}-${safe}`;
    const { url } = await put(key, buf, { access: 'public', contentType: ct, addRandomSuffix: false });

    return res.status(200).json({ success: true, url, filename: safe });
  } catch (e) {
    console.error('[store/cv-upload]', e);
    return res.status(500).json({ success: false, message: e.message || 'Upload mislukt.' });
  }
}
