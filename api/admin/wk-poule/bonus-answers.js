import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getCorrectBonusAnswers, setCorrectBonusAnswers, getBonusQuestions } from '../../../lib/wk-poule-store.js';
import { invalidateLeaderboardCache } from '../../wk-poule/leaderboard.js';

/**
 * /api/admin/wk-poule/bonus-answers
 *
 * Admin vult de juiste antwoorden voor bonusvragen in. De scoring engine
 * gebruikt deze als referentie.
 *
 * GET  → { questions, answers: { 'bq-id': '...' }, updatedAt, updatedBy }
 * POST { answers: { 'bq-id': '...' } } — overschrijft de hele set
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      const [questions, correct] = await Promise.all([
        getBonusQuestions(),
        getCorrectBonusAnswers()
      ]);
      return res.status(200).json({
        success: true,
        questions: questions.questions || [],
        answers: correct.answers || {},
        updatedAt: correct.updatedAt,
        updatedBy: correct.updatedBy
      });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      if (!body || typeof body.answers !== 'object') {
        return res.status(400).json({ success: false, message: 'answers-object is verplicht.' });
      }
      const payload = await setCorrectBonusAnswers(body.answers, body?.actor || 'admin');
      try { invalidateLeaderboardCache(); } catch (e) { /* skip */ }
      return res.status(200).json({ success: true, ...payload });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/wk-poule/bonus-answers]', error);
    return res.status(400).json({ success: false, message: error.message || 'Fout.' });
  }
}
