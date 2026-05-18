/**
 * GET /api/admin/monthly-winners
 *
 * Frontend endpoint voor banner + trofeekast.
 *
 * Query opties:
 *   ?current=true        — alleen de huidige (meest recente) winnaar
 *   ?month=2026-04       — specifieke maand
 *   ?limit=12            — laatste N maanden (default 12)
 *   ?allTime=true        — all-time leaderboard
 *   ?public=true         — gebruik tijdelijk voor publieke read
 *
 * Response (current=true):
 *   { success: true, month, monthName, winner, subWinners, bottom3?: hidden if public }
 */

import {
  readCurrentWinner,
  readMonthWinner,
  readRecentWinners,
  readAllTimeLeaderboard,
  readWinnersIndex
} from '../../lib/monthly-winners-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isPublicMode(req) {
  return String(req.query.public || '') === 'true';
}

function isAuthorized(req) {
  if (isPublicMode(req)) return true;
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

const DUTCH_MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function monthLabel(yyyymm) {
  if (!yyyymm) return '';
  const [year, month] = String(yyyymm).split('-');
  const monthIndex = Math.max(0, Math.min(11, Number(month) - 1));
  return `${DUTCH_MONTHS[monthIndex]} ${year}`;
}

/* Strip internal-only velden bij publieke read. */
function stripForPublic(winner) {
  if (!winner) return null;
  return {
    month: winner.month,
    monthName: winner.monthName || monthLabel(winner.month),
    periodFrom: winner.periodFrom,
    periodTo: winner.periodTo,
    winner: winner.winner,
    subWinners: winner.subWinners,
    generatedAt: winner.generatedAt
    /* allRows en bottom3 worden weggelaten in publieke modus. */
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const isPublic = isPublicMode(req);

  try {
    /* Mode: huidige winnaar */
    if (String(req.query.current || '') === 'true') {
      const winner = await readCurrentWinner();
      if (!winner) {
        return res.status(200).json({
          success: true,
          current: null,
          message: 'Nog geen winnaar bekend. Eerste cron-run staat gepland op de 1e van volgende maand.'
        });
      }
      return res.status(200).json({
        success: true,
        current: isPublic ? stripForPublic(winner) : winner
      });
    }

    /* Mode: specifieke maand */
    const monthFilter = String(req.query.month || '').match(/^\d{4}-\d{2}$/)?.[0];
    if (monthFilter) {
      const winner = await readMonthWinner(monthFilter);
      if (!winner) {
        return res.status(404).json({ success: false, message: `Geen winnaar voor ${monthFilter}.` });
      }
      return res.status(200).json({
        success: true,
        winner: isPublic ? stripForPublic(winner) : winner
      });
    }

    /* Mode: all-time leaderboard */
    if (String(req.query.allTime || '') === 'true') {
      const leaderboard = await readAllTimeLeaderboard();
      return res.status(200).json({ success: true, leaderboard });
    }

    /* Mode: trend per store (laatste N maanden score-verloop) */
    if (String(req.query.trend || '') === 'true') {
      const storeFilter = String(req.query.store || '').trim();
      if (!storeFilter) {
        return res.status(400).json({ success: false, message: '?store= is verplicht voor trend.' });
      }
      const monthsLimit = Math.max(1, Math.min(24, Number(req.query.months || 6) || 6));
      const recent = await readRecentWinners(monthsLimit);
      const series = recent
        .slice()
        .reverse() /* oudste eerst voor chart */
        .map((row) => {
          const storeRow = (row.allRows || []).find((r) => r.store === storeFilter);
          return {
            month: row.month,
            monthName: row.monthName || monthLabel(row.month),
            score: storeRow ? storeRow.score : null,
            eligible: storeRow ? storeRow.eligible : false,
            transactions: storeRow ? storeRow.transactions : 0,
            pillars: storeRow ? storeRow.pillars : null,
            isWinner: row.winner?.store === storeFilter,
            isSubWinner: ['customers', 'loyalty', 'crossChannel', 'data'].filter((k) => row.subWinners?.[k]?.store === storeFilter)
          };
        });
      return res.status(200).json({
        success: true,
        store: storeFilter,
        months: monthsLimit,
        series
      });
    }

    /* Default: laatste N maanden */
    const limit = Math.max(1, Math.min(60, Number(req.query.limit || 12) || 12));
    const recent = await readRecentWinners(limit);
    const index = await readWinnersIndex();

    return res.status(200).json({
      success: true,
      months: index.months || [],
      current: index.current || '',
      recent: isPublic ? recent.map(stripForPublic) : recent
    });
  } catch (error) {
    console.error('[monthly-winners]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Onverwachte fout bij ophalen winnaars.'
    });
  }
}
