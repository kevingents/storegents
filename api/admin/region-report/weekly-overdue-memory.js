import { getAdminToken } from '../../../lib/gents-mail-config.js';
import { addLoggedWeeklyOverdueOrders } from '../../../lib/region-weekly-overdue-memory.js';

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function authorized(req) {
  const expected = getAdminToken();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function startOfPreviousWeek() {
  const now = new Date();
  const day = now.getDay() || 7;
  const mondayThisWeek = addDays(now, 1 - day);
  return addDays(mondayThisWeek, -7);
}

function endOfPreviousWeek() {
  return addDays(startOfPreviousWeek(), 6);
}

function rowToJson(row) {
  return {
    ...row,
    overdueKeys: Array.from(row.overdueKeys || []),
    currentOverdueKeys: Array.from(row.currentOverdueKeys || []),
    historicalOverdueKeys: Array.from(row.historicalOverdueKeys || [])
  };
}

export default async function handler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!authorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const dateFrom = String(req.query.dateFrom || req.query.from || isoDate(startOfPreviousWeek())).trim();
  const dateTo = String(req.query.dateTo || req.query.to || isoDate(endOfPreviousWeek())).trim();
  const map = new Map();
  await addLoggedWeeklyOverdueOrders(map, { dateFrom, dateTo });
  const rows = Array.from(map.values()).map(rowToJson).sort((a, b) => b.overdueCount - a.overdueCount || a.store.localeCompare(b.store, 'nl'));

  return res.status(200).json({
    success: true,
    dateFrom,
    dateTo,
    rows,
    totals: {
      stores: rows.length,
      overdueOrders: rows.reduce((sum, row) => sum + Number(row.overdueCount || 0), 0)
    }
  });
}
