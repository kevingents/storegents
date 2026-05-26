import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getSchedule, setMatchResult } from '../../../lib/wk-poule-store.js';
import { invalidateLeaderboardCache } from '../../wk-poule/leaderboard.js';

/**
 * /api/admin/wk-poule/match-result
 *
 * Admin vult uitslag in voor een gespeelde wedstrijd. Triggert ook een
 * cache-invalidate van de leaderboard zodat de modal direct fresh data
 * laat zien.
 *
 * GET  → { schedule: { matches: [...] } } (admin-overzicht)
 * POST { matchId, homeScore, awayScore }  → boekt uitslag
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
      const data = await getSchedule();
      return res.status(200).json({ success: true, matches: data.matches || [] });
    }

    if (req.method === 'POST') {
      const body = parseBody(req);
      const matchId = String(body?.matchId || '').trim();
      const homeScore = body?.homeScore;
      const awayScore = body?.awayScore;

      if (!matchId) {
        return res.status(400).json({ success: false, message: 'matchId is verplicht.' });
      }
      if (homeScore == null || awayScore == null || !Number.isFinite(Number(homeScore)) || !Number.isFinite(Number(awayScore))) {
        return res.status(400).json({ success: false, message: 'homeScore en awayScore zijn verplicht (getallen).' });
      }

      const updated = await setMatchResult(matchId, {
        homeScore: Number(homeScore),
        awayScore: Number(awayScore)
      }, body?.actor || 'admin');

      /* Leaderboard-cache invalideren — volgende /leaderboard GET rebuild'd */
      try { invalidateLeaderboardCache(); } catch (e) { /* skip */ }

      return res.status(200).json({ success: true, match: updated });
    }

    return res.status(405).json({ success: false, message: 'Methode niet toegestaan.' });
  } catch (error) {
    console.error('[admin/wk-poule/match-result]', error);
    return res.status(400).json({ success: false, message: error.message || 'Fout.' });
  }
}
