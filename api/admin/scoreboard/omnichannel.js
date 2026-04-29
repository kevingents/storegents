import { getCustomers } from '../../../lib/srs-customers-client.js';
import { getVoucherLogs } from '../../../lib/voucher-log-store.js';
import { listBranches, calculateOmnichannelScore } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const SCOREBOARD_CACHE_TTL_MS = Math.max(1000, Number(process.env.OMNICHANNEL_SCOREBOARD_CACHE_MS || 2 * 60 * 1000) || 2 * 60 * 1000);
const SCOREBOARD_CACHE_MAX_ENTRIES = 100;
const scoreboardCache = new Map();

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDate(date);
}

function matchesPeriod(dateValue, dateFrom, dateTo) {
  if (!dateValue) return false;

  const date = String(dateValue).slice(0, 10);

  if (dateFrom && date < dateFrom) return false;
  if (dateTo && date > dateTo) return false;

  return true;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function toBranchKey(value) {
  return String(value || '').trim();
}

function isVoucherUsedStatus(status) {
  return [
    'afgeboekt_in_srs',
    'gebruikt_in_winkel_shopify_gedeactiveerd',
    'gebruikt_in_winkel_geen_shopify',
    'gebruikt_in_shopify'
  ].includes(String(status || ''));
}

function pruneScoreboardCache() {
  if (scoreboardCache.size <= SCOREBOARD_CACHE_MAX_ENTRIES) return;
  const oldestKey = scoreboardCache.keys().next().value;
  if (oldestKey) scoreboardCache.delete(oldestKey);
}

function aggregateCustomersByBranch(customers, dateFrom, dateTo) {
  const map = new Map();

  for (const customer of customers) {
    if (!matchesPeriod(customer.createdAt, dateFrom, dateTo)) continue;
    const branchKey = toBranchKey(customer.registeredInBranchId);
    if (!branchKey) continue;

    const row = map.get(branchKey) || { customerRegistrations: 0, loyaltyOptIn: 0 };
    row.customerRegistrations += 1;
    if (String(customer.receivesLoyaltyPoints).toLowerCase() === 'true') {
      row.loyaltyOptIn += 1;
    }
    map.set(branchKey, row);
  }

  return map;
}

function aggregateVoucherMetricsByBranch(logs, dateFrom, dateTo, storeToBranchId) {
  const map = new Map();

  for (const log of logs) {
    if (!matchesPeriod(log.createdAt, dateFrom, dateTo)) continue;

    const byBranchId = toBranchKey(log.srsRedeemBranchId);
    const byStore = toBranchKey(storeToBranchId.get(String(log.store || '').trim()));
    const branchKey = byBranchId || byStore;
    if (!branchKey) continue;

    const row = map.get(branchKey) || { voucherIssued: 0, voucherUsed: 0 };
    row.voucherIssued += 1;
    if (isVoucherUsedStatus(log.status)) row.voucherUsed += 1;
    map.set(branchKey, row);
  }

  return map;
}

function buildBranchScore(branch, customerAggByBranch, voucherAggByBranch, hasCustomerData) {
  const branchKey = toBranchKey(branch.branchId);
  const customerAgg = customerAggByBranch.get(branchKey) || { customerRegistrations: 0, loyaltyOptIn: 0 };
  const vouchers = voucherAggByBranch.get(branchKey) || { voucherIssued: 0, voucherUsed: 0 };

  const score = calculateOmnichannelScore({
    customerRegistrations: customerAgg.customerRegistrations,
    loyaltyOptIn: customerAgg.loyaltyOptIn,
    voucherIssued: vouchers.voucherIssued,
    voucherUsed: vouchers.voucherUsed,
    labelCreated: 0
  });

  return {
    store: branch.store,
    branchId: branch.branchId,
    customerError: '',
    dataQuality: {
      hasCustomerData,
      hasBranchCustomers: customerAgg.customerRegistrations > 0,
      hasVoucherData: vouchers.voucherIssued > 0
    },
    ...score
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const dateFrom = String(req.query.dateFrom || req.query.from || daysAgo(7)).trim();
    const dateTo = String(req.query.dateTo || req.query.to || isoDate(new Date())).trim();
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      return res.status(400).json({
        success: false,
        message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.'
      });
    }
    if (dateFrom > dateTo) {
      return res.status(400).json({
        success: false,
        message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.'
      });
    }

    const cacheKey = `${dateFrom}|${dateTo}`;
    const cached = scoreboardCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < SCOREBOARD_CACHE_TTL_MS) {
      return res.status(200).json({
        ...cached.payload,
        cache: { hit: true, ttlMs: SCOREBOARD_CACHE_TTL_MS }
      });
    }

    const branches = listBranches();
    const storeToBranchId = new Map(branches.map((branch) => [String(branch.store || '').trim(), String(branch.branchId || '').trim()]));
    const logs = await getVoucherLogs();
    const customerResult = await getCustomers({
      createdFrom: `${dateFrom}T00:00:00`,
      createdUntil: `${dateTo}T23:59:59`
    });
    const customers = customerResult.customers || [];
    const customerAggByBranch = aggregateCustomersByBranch(customers, dateFrom, dateTo);
    const voucherAggByBranch = aggregateVoucherMetricsByBranch(logs, dateFrom, dateTo, storeToBranchId);

    const rows = branches
      .map((branch) => buildBranchScore(branch, customerAggByBranch, voucherAggByBranch, customers.length > 0))
      .sort((a, b) => b.score - a.score);

    const payload = {
      success: true,
      dateFrom,
      dateTo,
      mode: 'server-filter+local-aggregate',
      sourceCustomerCount: customers.length,
      formula: {
        customerRegistrations: '35%',
        loyaltyOptInRate: '25%',
        voucherUsageRate: '25%',
        serviceLabelActivity: '15%'
      },
      dataQuality: {
        sourceCustomerCount: customers.length,
        hasCustomerData: customers.length > 0
      },
      rows
    };

    scoreboardCache.set(cacheKey, {
      createdAt: Date.now(),
      payload
    });
    pruneScoreboardCache();

    return res.status(200).json({
      ...payload,
      cache: { hit: false, ttlMs: SCOREBOARD_CACHE_TTL_MS }
    });
  } catch (error) {
    console.error('Omnichannel scoreboard error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Omnichannel score kon niet worden berekend.',
      hint: 'SRS GetCustomers gaf een fout. Controleer SRS_MESSAGE_USER, SRS_MESSAGE_PASSWORD en of de Customers webservice is geactiveerd.'
    });
  }
}
