import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getBonusQuestions } from '../../lib/wk-poule-store.js';

/**
 * /api/wk-poule/bonus-questions
 *
 * Publieke GET — bonusvragen voor de poule. Gebruikt door de WK Poule modal
 * "Bonusvragen" tab. Vragen worden beheerd door admin via een aparte
 * admin-endpoint (toekomstig).
 */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const data = await getBonusQuestions();
    return res.status(200).json({
      success: true,
      questions: data.questions || []
    });
  } catch (error) {
    console.error('[wk-poule/bonus-questions]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Bonusvragen konden niet worden geladen.',
      questions: []
    });
  }
}
