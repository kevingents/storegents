import {
  loginSrsPointsService,
  getPointsBalance
} from '../../../lib/srs-points-client.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

/**
 * GET /api/admin/points/stats
 *
 * Lightweight stats over loyalty-punten. Anders dan
 * /api/admin/points/eligible-voucher-customers (welke per klant
 * Shopify + SRS lookups doet voor de eligibility-tabel), doet dit
 * endpoint ENKEL 1 SRS-call (getPointsBalance) en aggregeert dat.
 *
 * Response:
 *   {
 *     success,
 *     totalCustomers,            // alle balances (ook 0 of negatief)
 *     customersWithPoints,       // balances > 0
 *     customersWithZeroPoints,
 *     customersNegativePoints,   // edge case
 *     totalPoints,               // som van positieve balances (in circulatie)
 *     totalPointsValue,          // x pointValue (default 0.05 eur)
 *     eligibleCustomers,         // balances >= minimumPoints (voor 1+ voucher)
 *     eligiblePoints,
 *     avgPointsPerCustomer,
 *     topCustomers: [...],       // top 10 by balance
 *     rules: {minimumAmount, pointValue, minimumPoints}
 *   }
 *
 * Cache: 10 min in-memory (admin-only call, niet hot pad).
 */

const CACHE_TTL_MS = Number(process.env.POINTS_STATS_CACHE_MS || 10 * 60 * 1000);
let cached = { at: 0, data: null };

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function getRules(req) {
  const q = req.query || {};
  const minimumAmount = Number(String(q.minimumAmount || process.env.LOYALTY_VOUCHER_MINIMUM || process.env.VOUCHER_MIN_AMOUNT_EUR || '25').replace(',', '.')) || 25;
  const pointValue = Number(String(q.pointValue || process.env.VOUCHER_POINT_VALUE_EUR || '0.05').replace(',', '.')) || 0.05;
  const minimumPoints = Math.ceil(minimumAmount / pointValue);
  return { minimumAmount, pointValue, minimumPoints };
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

  const skipCache = String(req.query.refresh || '') === '1';
  if (!skipCache && cached.data && (Date.now() - cached.at) < CACHE_TTL_MS) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  const customerFrom = field(req.query.customerFrom || process.env.POINTS_SYNC_CUSTOMER_FROM || '1').trim();
  const customerTo = field(req.query.customerTo || process.env.POINTS_SYNC_CUSTOMER_TO || '999999999').trim();
  const dateTo = field(req.query.dateTo || new Date().toISOString().slice(0, 10)).trim();
  const dateFrom = field(req.query.dateFrom || process.env.POINTS_SYNC_DATE_FROM || '2000-01-01').trim();

  const rules = getRules(req);

  try {
    const sessionId = await loginSrsPointsService();
    const { balances } = await getPointsBalance({
      customerFrom, customerTo, dateFrom, dateTo, sessionId
    });

    let customersWithPoints = 0;
    let customersWithZeroPoints = 0;
    let customersNegativePoints = 0;
    let totalPoints = 0;
    let eligibleCustomers = 0;
    let eligiblePoints = 0;

    for (const b of balances) {
      const bal = Number(b.balance || 0);
      if (bal > 0) {
        customersWithPoints += 1;
        totalPoints += bal;
        if (bal >= rules.minimumPoints) {
          eligibleCustomers += 1;
          eligiblePoints += bal;
        }
      } else if (bal === 0) {
        customersWithZeroPoints += 1;
      } else {
        customersNegativePoints += 1;
      }
    }

    /* Top 10 klanten op saldo */
    const topCustomers = balances
      .filter((b) => Number(b.balance || 0) > 0)
      .sort((a, b) => Number(b.balance || 0) - Number(a.balance || 0))
      .slice(0, 10)
      .map((b) => ({
        customerId: b.customerId,
        balance: Number(b.balance || 0),
        estimatedValue: Number((Number(b.balance || 0) * rules.pointValue).toFixed(2))
      }));

    const data = {
      success: true,
      totalCustomers: balances.length,
      customersWithPoints,
      customersWithZeroPoints,
      customersNegativePoints,
      totalPoints: Math.round(totalPoints),
      totalPointsValue: Number((totalPoints * rules.pointValue).toFixed(2)),
      eligibleCustomers,
      eligiblePoints: Math.round(eligiblePoints),
      eligiblePointsValue: Number((eligiblePoints * rules.pointValue).toFixed(2)),
      avgPointsPerCustomer: customersWithPoints > 0
        ? Math.round(totalPoints / customersWithPoints)
        : 0,
      topCustomers,
      rules,
      generatedAt: new Date().toISOString()
    };

    cached = { at: Date.now(), data };
    return res.status(200).json(data);
  } catch (error) {
    console.error('[points/stats] error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Punten-stats konden niet worden opgehaald.'
    });
  }
}
