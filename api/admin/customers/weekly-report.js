import { getCustomers } from '../../../lib/srs-customers-client.js';
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

function isInPeriod(customer, dateFrom, dateTo) {
  if (!customer.createdAt) return false;

  const createdDate = String(customer.createdAt).slice(0, 10);

  if (dateFrom && createdDate < dateFrom) return false;
  if (dateTo && createdDate > dateTo) return false;

  return true;
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

function aggregateByBranch(customers, branches, dateFrom, dateTo) {
  return branches.map((branch) => {
    const branchCustomers = customers.filter((customer) => {
      if (!isInPeriod(customer, dateFrom, dateTo)) return false;
      return String(customer.registeredInBranchId || '') === String(branch.branchId || '');
    });

    return {
      store: branch.store,
      branchId: branch.branchId,
      ...summarizeCustomers(branchCustomers),
      customers: branchCustomers
    };
  });
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

    const branches = branchId
      ? [{ store: getStoreNameByBranchId(branchId), branchId }]
      : listBranches();

    /*
      Belangrijk:
      De SRS Customers documentatie toont GetCustomers zoekfilters voor o.a. customer/card/address,
      maar niet officieel voor Created/RegisteredInBranchId. Daarom halen we klanten één keer op
      en filteren we lokaal op CreatedAt en RegisteredInBranchId. Dit voorkomt 21 losse SOAP-fouten.
    */
    const result = await getCustomers({});
    const allCustomers = result.customers || [];

    const rows = aggregateByBranch(allCustomers, branches, dateFrom, dateTo);
    const filteredCustomers = allCustomers.filter((customer) => isInPeriod(customer, dateFrom, dateTo));
    const totals = summarizeCustomers(filteredCustomers);

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      mode: 'local-filter',
      sourceCustomerCount: allCustomers.length,
      totals,
      rows,
      errors: []
    });
  } catch (error) {
    console.error('Customer weekly report error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Klantinschrijvingen konden niet worden opgehaald.',
      hint: 'SRS GetCustomers gaf een fout. Controleer SRS_MESSAGE_USER, SRS_MESSAGE_PASSWORD en of de Customers webservice is geactiveerd.'
    });
  }
}
