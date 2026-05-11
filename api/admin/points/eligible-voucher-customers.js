import {
  loginSrsPointsService,
  getPointsBalance,
  getPointsMutations,
  getLatestBranchByCustomer
} from '../../../lib/srs-points-client.js';
import { findShopifyCustomerBySrsCustomerId } from '../../../lib/shopify-gift-card-client.js';
import { appendPointsSyncLog } from '../../../lib/points-sync-log-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
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

function getBranchName(branchId) {
  const raw = process.env.SRS_BRANCH_MAP_JSON || '';
  if (!raw || !branchId) return '';

  try {
    const map = JSON.parse(raw);
    return map[String(branchId)] || '';
  } catch (error) {
    console.error('SRS_BRANCH_MAP_JSON is ongeldig:', error);
    return '';
  }
}

function getRange(req) {
  const query = req.query || {};
  const body = req.body || {};

  const customerFrom = field(query.customerFrom || body.customerFrom || process.env.POINTS_SYNC_CUSTOMER_FROM || '1').trim();
  const customerTo = field(query.customerTo || body.customerTo || process.env.POINTS_SYNC_CUSTOMER_TO || '999999999').trim();
  const dateTo = field(query.dateTo || body.dateTo || new Date().toISOString().slice(0, 10)).trim();
  const dateFrom = field(query.dateFrom || body.dateFrom || process.env.POINTS_SYNC_DATE_FROM || '2000-01-01').trim();
  const mutationDays = Number(query.mutationDays || body.mutationDays || process.env.POINTS_SYNC_MUTATION_DAYS || 90) || 90;
  const mutationDateFrom = field(query.mutationDateFrom || body.mutationDateFrom || '').trim()
    || new Date(Date.now() - 1000 * 60 * 60 * 24 * mutationDays).toISOString().slice(0, 10);

  return { customerFrom, customerTo, dateFrom, dateTo, mutationDateFrom };
}

function getRules(req) {
  const query = req.query || {};
  const body = req.body || {};
  const minimumAmount = Number(String(query.minimumAmount || body.minimumAmount || process.env.LOYALTY_VOUCHER_MINIMUM || process.env.VOUCHER_MIN_AMOUNT_EUR || '25').replace(',', '.')) || 25;
  const pointValue = Number(String(query.pointValue || body.pointValue || process.env.VOUCHER_POINT_VALUE_EUR || '0.05').replace(',', '.')) || 0.05;
  const minimumPoints = Math.ceil(minimumAmount / pointValue);

  return { minimumAmount, pointValue, minimumPoints };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const includeShopify = String(req.query.includeShopify || req.body?.includeShopify || 'true') !== 'false';
  const logUnmatched = String(req.query.logUnmatched || req.body?.logUnmatched || 'true') !== 'false';
  const range = getRange(req);
  const rules = getRules(req);
  const srsCustomerNamespace = String(process.env.SRS_CUSTOMER_ID_METAFIELD_NAMESPACE || 'SRSERP');
  const srsCustomerKey = String(process.env.SRS_CUSTOMER_ID_METAFIELD_KEY || 'customer_id');

  try {
    const sessionId = await loginSrsPointsService();
    const [{ balances }, { mutations }] = await Promise.all([
      getPointsBalance({
        customerFrom: range.customerFrom,
        customerTo: range.customerTo,
        dateFrom: range.dateFrom,
        dateTo: range.dateTo,
        sessionId
      }),
      getPointsMutations({
        customerFrom: range.customerFrom,
        customerTo: range.customerTo,
        dateFrom: range.mutationDateFrom,
        dateTo: range.dateTo,
        sessionId
      })
    ]);

    const latestBranchByCustomer = getLatestBranchByCustomer(mutations);
    const eligibleBalances = balances.filter((item) => Number(item.balance || 0) >= rules.minimumPoints);
    const eligible = [];
    const unmatched = [];

    for (const balance of eligibleBalances) {
      const srsCustomerId = String(balance.customerId || '').trim();
      const latestMutation = latestBranchByCustomer.get(srsCustomerId);
      const branchId = latestMutation?.branchId || '';
      const branchName = getBranchName(branchId);
      const estimatedVoucherAmount = Number((Number(balance.balance || 0) * rules.pointValue).toFixed(2));

      let shopifyCustomer = null;

      if (includeShopify) {
        shopifyCustomer = await findShopifyCustomerBySrsCustomerId(srsCustomerId, srsCustomerNamespace, srsCustomerKey);
      }

      const row = {
        srsCustomerId,
        originalSrsCustomerId: balance.originalCustomerId || '',
        pointsBalance: Number(balance.balance || 0),
        estimatedVoucherAmount,
        minimumPoints: rules.minimumPoints,
        minimumAmount: rules.minimumAmount,
        branchId,
        branchName,
        shopifyFound: Boolean(shopifyCustomer?.id),
        shopifyCustomerId: shopifyCustomer?.id || '',
        shopifyCustomerEmail: shopifyCustomer?.email || '',
        shopifyCustomerName: shopifyCustomer?.displayName || '',
        latestMutation: latestMutation || null
      };

      eligible.push(row);

      if (includeShopify && !shopifyCustomer?.id) {
        unmatched.push(row);

        if (logUnmatched) {
          await appendPointsSyncLog({
            type: 'eligible_customer_unmatched',
            status: 'not_found',
            message: `Klant heeft genoeg punten maar geen Shopify klant gevonden met ${srsCustomerNamespace}.${srsCustomerKey}.`,
            srsCustomerId,
            originalSrsCustomerId: balance.originalCustomerId || '',
            pointsBalance: balance.balance,
            branchId,
            branchName,
            details: row
          });
        }
      }
    }

    return res.status(200).json({
      success: true,
      range,
      rules,
      lookupMetafield: `${srsCustomerNamespace}.${srsCustomerKey}`,
      totalBalances: balances.length,
      eligibleCount: eligible.length,
      shopifyMatched: eligible.filter((item) => item.shopifyFound).length,
      unmatchedCount: unmatched.length,
      eligible,
      unmatched
    });
  } catch (error) {
    console.error('Eligible voucher customers error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Klanten met genoeg punten konden niet worden opgehaald.',
      details: error.fault || null
    });
  }
}
