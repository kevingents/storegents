import {
  loginSrsPointsService,
  getPointsBalance,
  getPointsMutations,
  getLatestBranchByCustomer
} from '../../../lib/srs-points-client.js';
import { getCustomers } from '../../../lib/srs-customers-client.js';
import {
  findShopifyCustomerByEmail,
  findShopifyCustomerBySrsCustomerId
} from '../../../lib/shopify-gift-card-client.js';
import { appendPointsSyncLog } from '../../../lib/points-sync-log-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

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
  const maxVouchersPerCustomer = Number(query.maxVouchersPerCustomer || body.maxVouchersPerCustomer || process.env.LOYALTY_VOUCHER_MAX_PER_CUSTOMER || 10) || 10;

  return { minimumAmount, pointValue, minimumPoints, maxVouchersPerCustomer };
}

function getVoucherBreakdown(pointsBalance, rules) {
  const points = Math.floor(Number(pointsBalance || 0));
  const rawVoucherCount = Math.floor(points / rules.minimumPoints);
  const voucherCount = Math.max(0, Math.min(rawVoucherCount, rules.maxVouchersPerCustomer));
  const remainingPoints = points - (voucherCount * rules.minimumPoints);
  const voucherAmount = Number(rules.minimumAmount.toFixed(2));
  const totalVoucherAmount = Number((voucherCount * voucherAmount).toFixed(2));

  return {
    voucherCount,
    voucherAmount,
    totalVoucherAmount,
    remainingPoints,
    capped: rawVoucherCount > voucherCount,
    rawVoucherCount
  };
}

function removeLeadingLetters(value) {
  return String(value || '').trim().replace(/^[A-Za-z]+/, '');
}

function uniqueIds(ids) {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function customerLookupIds(...ids) {
  const values = [];

  ids.forEach((id) => {
    const clean = String(id || '').trim();
    if (!clean) return;
    const withoutLetters = removeLeadingLetters(clean);
    values.push(withoutLetters, clean);
  });

  return uniqueIds(values);
}

async function getSrsCustomerByIds(ids) {
  for (const id of customerLookupIds(...ids)) {
    try {
      const result = await getCustomers({ customerId: id });
      const customer = result.customers?.[0] || null;
      if (customer?.email) return { customer, matchedSrsCustomerId: id };
      if (customer?.customerId) return { customer, matchedSrsCustomerId: id };
    } catch (error) {
      console.error('SRS customer lookup error:', id, error.message);
    }
  }

  return { customer: null, matchedSrsCustomerId: '' };
}

async function findShopifyCustomer({ email, ids, namespace, key }) {
  const cleanEmail = String(email || '').trim().toLowerCase();

  if (cleanEmail) {
    const byEmail = await findShopifyCustomerByEmail(cleanEmail);
    if (byEmail?.id) return { customer: byEmail, matchType: 'email', matchedValue: cleanEmail };
  }

  for (const id of customerLookupIds(...ids)) {
    const bySrsId = await findShopifyCustomerBySrsCustomerId(id, namespace, key);
    if (bySrsId?.id) return { customer: bySrsId, matchType: 'srs_customer_id', matchedValue: id };
  }

  return { customer: null, matchType: '', matchedValue: '' };
}

export const maxDuration = 60;

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

    const totalPointsInCirculation = balances.reduce((sum, item) => sum + Math.max(0, Number(item.balance || 0)), 0);
    const totalPointsRaw = balances.reduce((sum, item) => sum + Number(item.balance || 0), 0);
    const totalPointsValue = Number((totalPointsInCirculation * rules.pointValue).toFixed(2));

    const latestBranchByCustomer = getLatestBranchByCustomer(mutations);
    const eligibleBalances = balances.filter((item) => Number(item.balance || 0) >= rules.minimumPoints);
    const eligible = [];
    const unmatched = [];

    for (const balance of eligibleBalances) {
      const srsCustomerId = String(balance.customerId || '').trim();
      const originalSrsCustomerId = String(balance.originalCustomerId || '').trim();
      const normalizedSrsCustomerId = removeLeadingLetters(originalSrsCustomerId || srsCustomerId);
      const latestMutation = latestBranchByCustomer.get(srsCustomerId);
      const branchId = latestMutation?.branchId || '';
      const branchName = getBranchName(branchId);
      const estimatedVoucherAmount = Number((Number(balance.balance || 0) * rules.pointValue).toFixed(2));
      const voucherBreakdown = getVoucherBreakdown(balance.balance, rules);
      const srsCustomerLookup = await getSrsCustomerByIds([normalizedSrsCustomerId, srsCustomerId, originalSrsCustomerId]);
      const srsCustomer = srsCustomerLookup.customer;
      const srsEmail = String(srsCustomer?.email || '').trim().toLowerCase();

      let shopifyCustomer = null;
      let matchType = '';
      let matchedValue = '';

      if (includeShopify) {
        const lookup = await findShopifyCustomer({
          email: srsEmail,
          ids: [normalizedSrsCustomerId, srsCustomerId, originalSrsCustomerId],
          namespace: srsCustomerNamespace,
          key: srsCustomerKey
        });
        shopifyCustomer = lookup.customer;
        matchType = lookup.matchType;
        matchedValue = lookup.matchedValue;
      }

      const row = {
        srsCustomerId,
        originalSrsCustomerId,
        normalizedSrsCustomerId,
        srsCustomerLookupId: srsCustomerLookup.matchedSrsCustomerId,
        srsEmail,
        srsCustomerName: srsCustomer?.name || '',
        matchType,
        matchedValue,
        pointsBalance: Number(balance.balance || 0),
        estimatedVoucherAmount,
        voucherCount: voucherBreakdown.voucherCount,
        voucherAmount: voucherBreakdown.voucherAmount,
        totalVoucherAmount: voucherBreakdown.totalVoucherAmount,
        remainingPoints: voucherBreakdown.remainingPoints,
        rawVoucherCount: voucherBreakdown.rawVoucherCount,
        voucherCountCapped: voucherBreakdown.capped,
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
            message: srsEmail
              ? 'Klant heeft genoeg punten maar geen Shopify klant gevonden op e-mail.'
              : 'Klant heeft genoeg punten maar geen SRS e-mail gevonden.',
            srsCustomerId,
            originalSrsCustomerId,
            pointsBalance: balance.balance,
            branchId,
            branchName,
            shopifyCustomerEmail: srsEmail,
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
      primaryLookup: 'email',
      totalBalances: balances.length,
      totalPointsInCirculation,
      totalPointsRaw,
      totalPointsValue,
      eligibleCount: eligible.length,
      totalEligiblePoints: eligible.reduce((sum, item) => sum + Number(item.pointsBalance || 0), 0),
      totalVoucherCount: eligible.reduce((sum, item) => sum + Number(item.voucherCount || 0), 0),
      totalVoucherAmount: Number(eligible.reduce((sum, item) => sum + Number(item.totalVoucherAmount || 0), 0).toFixed(2)),
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
