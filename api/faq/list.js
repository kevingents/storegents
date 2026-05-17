import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getFaqItems } from '../../lib/faq-store.js';

/**
 * GET /api/faq/list
 * Public. Geeft alle FAQ-items terug (uit Blob of defaults).
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  try {
    const items = await getFaqItems();
    return res.status(200).json({ success: true, count: items.length, items });
  } catch (error) {
    console.error('[faq/list]', error);
    return res.status(500).json({ success: false, message: error.message || 'FAQ kon niet worden opgehaald.' });
  }
}
