import { getCustomersByBranchAndPeriod } from '../../../lib/srs-customers-client.js';
import { listBranches, getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(date = new Date()) {
  const copy = new Date(date);
  const day = copy.getDay() || 7;
  copy.setDate(copy.getDate() - day + 1);
  return copy;
}

function endOfWeek(date = new Date()) {
  const start = startOfWeek(date);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  return end;
}

function summarizeCustomers(customers) {
  const total = customers.length;
  const withEmail = customers.filter((customer) => customer.email).length;
  const mailingOptIn = customers.filter((customer) => String(customer.allowMailings).toLowerCase() === 'true').length;
  const loyaltyOptIn = customers.filter((customer) => String(customer.receivesLoyaltyPoints).toLowerCase() === 'true').length;

  return {
    total,
    withEmail,
    mailingOptIn,
    loyaltyOptIn,
    emailRate: total ? Math.round((withEmail / total) * 100) : 0,
    mailingOptInRate: total ? Math.round((mailingOptIn / total) * 100) : 0,
    loyaltyOptInRate: total ? Math.round((loyaltyOptIn / total) * 100) : 0
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
    const defaultFrom = isoDate(startOfWeek());
    const defaultTo = isoDate(endOfWeek());
    const dateFrom = String(req.query.dateFrom || req.query.from || defaultFrom).trim();
    const dateTo = String(req.query.dateTo || req.query.to || defaultTo).trim();
    const branchId = String(req.query.branchId || '').trim();
    const allBranches = String(req.query.allBranches || 'true') !== 'false';

    const branches = branchId
      ? [{ store: getStoreNameByBranchId(branchId), branchId }]
      : allBranches
        ? listBranches()
        : [];

    const rows = [];
    const allCustomers = [];
    const errors = [];

    if (!branches.length) {
      const result = await getCustomersByBranchAndPeriod({ dateFrom, dateTo });
      allCustomers.push(...result.customers);
    } else {
      for (const branch of branches) {
        try {
          const result = await getCustomersByBranchAndPeriod({
            branchId: branch.branchId,
            dateFrom,
            dateTo
          });

          const summary = summarizeCustomers(result.customers);

          rows.push({
            store: branch.store,
            branchId: branch.branchId,
            ...summary,
            customers: result.customers
          });

          allCustomers.push(...result.customers);
        } catch (error) {
          errors.push({
            store: branch.store,
            branchId: branch.branchId,
            message: error.message || 'Klanten konden niet worden opgehaald.'
          });
        }
      }
    }

    const totalSummary = summarizeCustomers(allCustomers);

    if (!rows.length && allCustomers.length) {
      rows.push({
        store: 'Alle winkels',
        branchId: '',
        ...totalSummary,
        customers: allCustomers
      });
    }

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      totals: totalSummary,
      rows,
      errors
    });
  } catch (error) {
    console.error('Customer weekly report error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Klantinschrijvingen konden niet worden opgehaald.'
    });
  }
}
