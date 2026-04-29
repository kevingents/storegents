import { getCustomers } from '../../../lib/srs-customers-client.js';
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

function buildBranchScore(branch, customers, logs, dateFrom, dateTo) {
  const branchCustomers = customers.filter((customer) => {
    if (!matchesPeriod(customer.createdAt, dateFrom, dateTo)) return false;
    return String(customer.registeredInBranchId || '') === String(branch.branchId || '');
  });

  const customerRegistrations = branchCustomers.length;
  const loyaltyOptIn = branchCustomers.filter((customer) => String(customer.receivesLoyaltyPoints).toLowerCase() === 'true').length;
  const vouchers = voucherMetricsForStore(logs, branch.store, branch.branchId, dateFrom, dateTo);

  const score = calculateOmnichannelScore({
    customerRegistrations,
    loyaltyOptIn,
    voucherIssued: vouchers.voucherIssued,
    voucherUsed: vouchers.voucherUsed,
    labelCreated: 0
  });

  return {
    store: branch.store,
    branchId: branch.branchId,
    customerError: '',
    dataQuality: {
      hasCustomerData: customers.length > 0,
      hasBranchCustomers: branchCustomers.length > 0,
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

    const branches = listBranches();
    const logs = await getVoucherLogs();
    const customerResult = await getCustomers({});
    const customers = customerResult.customers || [];

    const rows = branches
      .map((branch) => buildBranchScore(branch, customers, logs, dateFrom, dateTo))
      .sort((a, b) => b.score - a.score);

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      mode: 'local-filter',
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
