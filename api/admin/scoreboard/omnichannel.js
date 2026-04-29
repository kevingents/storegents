import { getCustomersByBranchAndPeriod } from '../../../lib/srs-customers-client.js';
import { getVoucherLogs } from '../../../lib/voucher-log-store.js';
import { listBranches, calculateOmnichannelScore } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

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

function voucherMetricsForStore(logs, store, branchId, dateFrom, dateTo) {
  const relevant = logs.filter((log) => {
    if (!matchesPeriod(log.createdAt, dateFrom, dateTo)) return false;

    return String(log.store || '') === store || String(log.srsRedeemBranchId || '') === String(branchId);
  });

  const issued = relevant.length;
  const used = relevant.filter((log) => [
    'afgeboekt_in_srs',
    'gebruikt_in_winkel_shopify_gedeactiveerd',
    'gebruikt_in_winkel_geen_shopify',
    'gebruikt_in_shopify'
  ].includes(log.status)).length;

  return {
    voucherIssued: issued,
    voucherUsed: used
  };
}

async function buildBranchScore(branch, logs, dateFrom, dateTo) {
  let customers = [];
  let customerError = '';

  try {
    const result = await getCustomersByBranchAndPeriod({
      branchId: branch.branchId,
      dateFrom,
      dateTo
    });

    customers = result.customers || [];
  } catch (error) {
    customerError = error.message || 'Klanten niet opgehaald.';
  }

  const customerRegistrations = customers.length;
  const loyaltyOptIn = customers.filter((customer) => String(customer.receivesLoyaltyPoints).toLowerCase() === 'true').length;
  const vouchers = voucherMetricsForStore(logs, branch.store, branch.branchId, dateFrom, dateTo);

  const labelCreated = logs.filter((log) => {
    // Placeholder for future Sendcloud/label KPI. Kept at 0 unless label metrics are merged.
    return false;
  }).length;

  const score = calculateOmnichannelScore({
    customerRegistrations,
    loyaltyOptIn,
    voucherIssued: vouchers.voucherIssued,
    voucherUsed: vouchers.voucherUsed,
    labelCreated
  });

  return {
    store: branch.store,
    branchId: branch.branchId,
    customerError,
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
    const branches = listBranches();
    const logs = await getVoucherLogs();

    const rows = [];

    for (const branch of branches) {
      rows.push(await buildBranchScore(branch, logs, dateFrom, dateTo));
    }

    rows.sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      formula: {
        customerRegistrations: '35%',
        loyaltyOptInRate: '25%',
        voucherUsageRate: '25%',
        serviceLabelActivity: '15%'
      },
      rows
    });
  } catch (error) {
    console.error('Omnichannel scoreboard error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Omnichannel score kon niet worden berekend.'
    });
  }
}
