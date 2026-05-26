/**
 * WK Poule scoring engine — puur functies, geen IO.
 *
 * Regels (matchen met getRules() / lib/wk-poule-store.js):
 *   - Juiste uitslag (exact):                      10 pt
 *   - Goede toto (winnaar OR beiden gelijkspel):    5 pt
 *   - Goed doelsaldo (home-away verschil):          3 pt
 *   - Anders:                                       0 pt
 *
 * Een match geeft de HOOGSTE score op (geen stapeling).
 *
 * Bonus-vragen: punten uit `question.points` als het antwoord case-insensitief
 * matcht met het correcte antwoord (text-trim + lowercase). Voor type='number'
 * wordt exacte match of margin (±5%) gebruikt.
 */

const POINTS_EXACT = 10;
const POINTS_TOTO  = 5;
const POINTS_SALDO = 3;

/**
 * Score voor één match-voorspelling.
 *
 * @param {object} pred      { home: number, away: number }
 * @param {object} match     { homeScore, awayScore, status }
 * @returns {object} { points, breakdown: 'exact'|'toto'|'saldo'|'wrong'|'pending' }
 */
export function scoreMatchPrediction(pred, match) {
  if (!match || match.status !== 'finished' || match.homeScore == null || match.awayScore == null) {
    return { points: 0, breakdown: 'pending' };
  }
  if (!pred || pred.home == null || pred.away == null || pred.home === '' || pred.away === '') {
    return { points: 0, breakdown: 'no-prediction' };
  }

  const ph = Number(pred.home);
  const pa = Number(pred.away);
  const mh = Number(match.homeScore);
  const ma = Number(match.awayScore);

  /* Exact = beide scores kloppen */
  if (ph === mh && pa === ma) {
    return { points: POINTS_EXACT, breakdown: 'exact' };
  }

  /* Toto = winnaar/gelijkspel goed voorspeld */
  const predResult = ph > pa ? 'home' : ph < pa ? 'away' : 'draw';
  const matchResult = mh > ma ? 'home' : mh < ma ? 'away' : 'draw';
  if (predResult === matchResult) {
    /* Saldo extra check binnen toto: als verschil exact klopt → 5 pt (toto = al hoger dan saldo) */
    return { points: POINTS_TOTO, breakdown: 'toto' };
  }

  /* Saldo (verschil) — alleen als toto fout was. */
  if ((ph - pa) === (mh - ma)) {
    return { points: POINTS_SALDO, breakdown: 'saldo' };
  }

  return { points: 0, breakdown: 'wrong' };
}

/**
 * Score voor één bonus-vraag.
 *
 * @param {*} answer            Gebruiker-antwoord
 * @param {*} correctAnswer     Juiste antwoord (door admin ingevuld)
 * @param {object} question     { id, type, points }
 * @returns {object} { points, breakdown }
 */
export function scoreBonusAnswer(answer, correctAnswer, question) {
  if (correctAnswer == null || correctAnswer === '') {
    return { points: 0, breakdown: 'pending' };
  }
  if (answer == null || answer === '') {
    return { points: 0, breakdown: 'no-answer' };
  }
  const max = Number(question?.points) || 0;
  if (question?.type === 'number') {
    const a = Number(answer);
    const c = Number(correctAnswer);
    if (!Number.isFinite(a) || !Number.isFinite(c)) {
      return { points: 0, breakdown: 'wrong' };
    }
    /* Exact = volle punten, ±5% = halve punten, anders 0 */
    if (a === c) return { points: max, breakdown: 'exact' };
    const tolerance = Math.max(1, Math.abs(c) * 0.05);
    if (Math.abs(a - c) <= tolerance) return { points: Math.floor(max / 2), breakdown: 'close' };
    return { points: 0, breakdown: 'wrong' };
  }
  /* Text: case-insensitief trim-vergelijking */
  const norm = (v) => String(v || '').trim().toLowerCase();
  if (norm(answer) === norm(correctAnswer)) {
    return { points: max, breakdown: 'exact' };
  }
  return { points: 0, breakdown: 'wrong' };
}

/**
 * Totaal-score voor één prediction.
 *
 * @param {object} prediction         Spelers inzending (zie wk-poule-store savePrediction)
 * @param {Array}  matches            Schedule met evt. uitslagen
 * @param {object} correctBonus       { 'bq-id': 'antwoord' }
 * @param {Array}  bonusQuestions     [{ id, type, points }, ...]
 * @returns {object} {
 *   totalPoints, matchPoints, bonusPoints,
 *   matchesScored, matchesCorrect,
 *   bonusScored, bonusCorrect,
 *   matchDetails:  { [matchId]: { points, breakdown, lastFinishedAt } },
 *   bonusDetails:  { [questionId]: { points, breakdown } }
 * }
 */
export function scorePrediction(prediction, matches, correctBonus, bonusQuestions) {
  const matchesArr = Array.isArray(matches) ? matches : [];
  const matchById = new Map(matchesArr.map((m) => [m.id, m]));
  const bonusQs = Array.isArray(bonusQuestions) ? bonusQuestions : [];
  const correct = correctBonus && typeof correctBonus === 'object' ? correctBonus : {};

  let matchPoints = 0;
  let matchesScored = 0;
  let matchesCorrect = 0;
  /* Voor "top week" gebruiken we de meest recente afgelopen match — keep
     lastWeekPoints = totaal van matches met resultEnteredAt in laatste 7d. */
  let lastWeekPoints = 0;
  const sevenDaysAgo = Date.now() - 7 * 86400_000;
  const matchDetails = {};

  const preds = (prediction && prediction.matches) || {};
  Object.entries(preds).forEach(([matchId, pred]) => {
    const match = matchById.get(matchId);
    if (!match) return;
    const r = scoreMatchPrediction(pred, match);
    matchDetails[matchId] = { ...r, finishedAt: match.resultEnteredAt || null };
    if (match.status === 'finished') {
      matchPoints += r.points;
      matchesScored += 1;
      if (r.points > 0) matchesCorrect += 1;
      /* Top-week telt match-punten van afgelopen 7d */
      const finishedTs = match.resultEnteredAt ? new Date(match.resultEnteredAt).getTime() : 0;
      if (finishedTs >= sevenDaysAgo) lastWeekPoints += r.points;
    }
  });

  let bonusPoints = 0;
  let bonusScored = 0;
  let bonusCorrect = 0;
  const bonusDetails = {};

  const userBonus = (prediction && prediction.bonus) || {};
  bonusQs.forEach((q) => {
    const corr = correct[q.id];
    if (corr == null || corr === '') return; /* admin nog niet ingevuld → niet scoren */
    const ans = userBonus[q.id];
    const r = scoreBonusAnswer(ans, corr, q);
    bonusDetails[q.id] = r;
    bonusScored += 1;
    bonusPoints += r.points;
    if (r.points > 0) bonusCorrect += 1;
  });

  const totalScored = matchesScored;
  const accuracyPct = totalScored ? Math.round((matchesCorrect / totalScored) * 100) : null;

  return {
    totalPoints: matchPoints + bonusPoints,
    matchPoints,
    bonusPoints,
    lastWeekPoints,
    matchesScored,
    matchesCorrect,
    bonusScored,
    bonusCorrect,
    accuracyPct,
    matchDetails,
    bonusDetails
  };
}

/**
 * Aggregeer scores van alle predictions naar leaderboards.
 *
 * @returns {object} {
 *   users:      [{ email, name, store, totalPoints, accuracyPct, matchesCorrect, lastWeekPoints }],
 *   stores:     [{ store, totalPoints, members, matchesCorrect, accuracyPct }],
 *   topWeek:    [{ email, name, store, lastWeekPoints }]  (top 3),
 *   summary:    { totalPlayers, totalMatchesScored, totalBonusScored }
 * }
 */
export function buildLeaderboards(predictions, matches, correctBonus, bonusQuestions) {
  const usersOut = [];
  const storeMap = new Map();

  for (const pred of (predictions || [])) {
    const score = scorePrediction(pred, matches, correctBonus, bonusQuestions);
    usersOut.push({
      email: pred.email,
      name: pred.name || pred.email,
      store: pred.store || '—',
      personnelNumber: pred.personnelNumber || '',
      totalPoints: score.totalPoints,
      matchPoints: score.matchPoints,
      bonusPoints: score.bonusPoints,
      lastWeekPoints: score.lastWeekPoints,
      matchesCorrect: score.matchesCorrect,
      matchesScored: score.matchesScored,
      accuracyPct: score.accuracyPct
    });

    const store = pred.store || '—';
    const cur = storeMap.get(store) || {
      store,
      totalPoints: 0,
      members: 0,
      matchesCorrect: 0,
      matchesScored: 0,
      lastWeekPoints: 0
    };
    cur.totalPoints += score.totalPoints;
    cur.lastWeekPoints += score.lastWeekPoints;
    cur.members += 1;
    cur.matchesCorrect += score.matchesCorrect;
    cur.matchesScored += score.matchesScored;
    storeMap.set(store, cur);
  }

  usersOut.sort((a, b) => b.totalPoints - a.totalPoints);
  const stores = [...storeMap.values()]
    .map((s) => ({
      ...s,
      accuracyPct: s.matchesScored ? Math.round((s.matchesCorrect / s.matchesScored) * 100) : null
    }))
    .sort((a, b) => b.totalPoints - a.totalPoints);

  const topWeek = [...usersOut]
    .filter((u) => u.lastWeekPoints > 0)
    .sort((a, b) => b.lastWeekPoints - a.lastWeekPoints)
    .slice(0, 3);

  return {
    users: usersOut,
    stores,
    topWeek,
    summary: {
      totalPlayers: usersOut.length,
      totalStores: stores.length,
      totalMatchesScored: usersOut.reduce((s, u) => s + u.matchesScored, 0)
    }
  };
}
