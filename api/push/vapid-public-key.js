/**
 * GET /api/push/vapid-public-key
 * Public — geserveerd zodat de SW kan registreren.
 */
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=3600');

  const key = String(process.env.VAPID_PUBLIC_KEY || '').trim();
  if (!key) {
    return res.status(200).json({
      success: false,
      configured: false,
      message: 'VAPID_PUBLIC_KEY niet ingesteld in Vercel. Push werkt nog niet.'
    });
  }
  return res.status(200).json({ success: true, configured: true, publicKey: key });
}
