import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import {
  listPredictions,
  getSchedule,
  getBonusQuestions,
  getCorrectBonusAnswers
} from '../../lib/wk-poule-store.js';
import { buildLeaderboards, scorePrediction } from '../../lib/wk-poule-scoring.js';

/**
 * /api/wk-poule/leaderboard
 *
 * Publieke endpoint die de live leaderboards levert. Gebruikt door de WK
 * Poule modal voor:
 *   - Winkelklassement (per winkel)
 *   - Collega's klassement (per gebruiker)
 *   - Top voorspeller van de week (top 3 op lastWeekPoints)
 *   - Mijn-winkel stats (positie van actieve winkel)
 *   - Mijn-stats (positie + accuracy van actieve gebruiker)
 *
 * Query parameters (optioneel):
 *   - email: hash-friendly identifier van de huidige gebruiker, zodat we
 *           "you" markeren in de user-leaderboard én jouw-stats teruggeven
 *   - store: huidige winkel, zodat we jouw-winkel-positie kunnen returnen
 *
 * Response:
 *   {
 *     success, stores: [...], users: [...], topWeek: [...],
 *     mySelf: { user, position } | null,
 *     myStore: { store, position } | null,
 *     summary: { ... }
 *   }
 */

const CACHE_TTL_MS = 60 * 1000; /* 60s — leaderboards mogen niet ouder zijn */
let cache = { at: 0, data: null };

async function buildFull() {
  if (cache.data && (Date.now() - cache.at) < CACHE_TTL_MS) return cache.data;
  const [predictions, schedule, bonusQs, correctBonus] = await Promise.all([
    listPredictions(),
    getSchedule(),
    getBonusQuestions(),
    getCorrectBonusAnswers()
  ]);
  const board = buildLeaderboards(
    predictions,
    schedule.matches || [],
    correctBonus.answers || {},
    bonusQs.questions || []
  );
  cache = { at: Date.now(), data: board };
  return board;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  /* Geen edge-cache — we hebben in-memory cache met TTL, en data verandert
     zodra admin een uitslag invoert (zelfde flow). */
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }

  try {
    const board = await buildFull();
    const meEmail = String(req.query?.email || '').trim().toLowerCase();
    const meStore = String(req.query?.store || '').trim();

    /* Markeer huidige user in users-array */
    const users = board.users.map((u, idx) => ({
      ...u,
      position: idx + 1,
      isMe: meEmail && u.email && u.email.toLowerCase() === meEmail
    }));

    /* Vind eigen-positie + winkel-positie */
    const mySelf = (() => {
      if (!meEmail) return null;
      const found = users.find((u) => u.isMe);
      if (!found) return null;
      return { user: found, position: found.position };
    })();

    const myStore = (() => {
      if (!meStore) return null;
      const idx = board.stores.findIndex((s) => s.store && s.store.toLowerCase() === meStore.toLowerCase());
      if (idx === -1) return null;
      return { ...board.stores[idx], position: idx + 1 };
    })();

    return res.status(200).json({
      success: true,
      stores: board.stores.map((s, idx) => ({ ...s, position: idx + 1 })),
      users,
      topWeek: board.topWeek,
      mySelf,
      myStore,
      summary: board.summary,
      cachedAt: new Date(cache.at).toISOString()
    });
  } catch (error) {
    console.error('[wk-poule/leaderboard]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Leaderboard kon niet worden geladen.',
      stores: [], users: [], topWeek: [], mySelf: null, myStore: null
    });
  }
}

/* Voor admin-flow: invalideer cache zodra een uitslag verandert. */
export function invalidateLeaderboardCache() {
  cache = { at: 0, data: null };
}
