import { getCustomers } from '../../../lib/srs-customers-client.js';
import { listBranches, getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const REPORT_CACHE_TTL_MS = Math.max(1000, Number(process.env.CUSTOMERS_WEEKLY_REPORT_CACHE_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
const reportCache = new Map();

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function startOfWeek(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay() || 7;
  d.setDate(d.getDate() - day + 1);
  return d;
}

function endOfWeek(date = new Date()) {
  const end = startOfWeek(date);
  end.setDate(end.getDate() + 6);
  return end;
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function isInPeriod(customer, dateFrom, dateTo) {
  if (!customer.createdAt) return false;
  const date = String(customer.createdAt).slice(0, 10);
  return date >= dateFrom && date <= dateTo;
}

function summarizeCustomers(customers) {
  const total = customers.length;
  const withEmail = customers.filter((customer) => customer.email).length;
  const mailingOptIn = customers.filter((customer) => String(customer.allowMailings).toLowerCase() === 'true').length;
  const loyaltyOptIn = customers.filter((customer) => String(customer.receivesLoyaltyPoints).toLowerCase() === 'true').length;
  const withReceipt = customers.filter((customer) => Number(customer.receiptCount || 0) > 0).length;
  const receiptCount = customers.reduce((sum, customer) => sum + (Number(customer.receiptCount || 0) || 0), 0);

  return {
    total,
    withEmail,
    withReceipt,
    receiptCount,
    mailingOptIn,
    loyaltyOptIn,
    emailRate: total ? Math.round((withEmail / total) * 100) : 0,
    receiptConversionRate: total ? Math.round((withReceipt / total) * 100) : 0,
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
      receiptCount: branchCustomers.reduce((sum, customer) => sum + Number(customer.receiptCount || 0), 0),
      ...summarizeCustomers(branchCustomers),
      customers: branchCustomers
    };
  });
}

function fallbackPayload({ dateFrom, dateTo, branchId, message }) {
  const branches = branchId
    ? [{ store: getStoreNameByBranchId(branchId), branchId }]
    : listBranches();

  return {
    success: true,
    degraded: true,
    dateFrom,
    dateTo,
    mode: 'safe-empty-fallback',
    sourceCustomerCount: 0,
    message,
    note: 'SRS Customers gaf geen tijdige response. Het rapport blijft zichtbaar, maar toont 0 totdat SRS Customers sneller reageert of een export/cache wordt gebruikt.',
    totals: summarizeCustomers([]),
    rows: branches.map((branch) => ({
      store: branch.store,
      branchId: branch.branchId,
      receiptCount: 0,
      total: 0,
      withEmail: 0,
      withReceipt: 0,
      mailingOptIn: 0,
      loyaltyOptIn: 0,
      emailRate: 0,
      receiptConversionRate: 0,
      mailingOptInRate: 0,
      loyaltyOptInRate: 0,
      customers: []
    })),
    errors: [{ message }]
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  const defaultFrom = isoDate(startOfWeek());
  const defaultTo = isoDate(endOfWeek());
  const dateFrom = String(req.query.dateFrom || req.query.from || defaultFrom).trim();
  const dateTo = String(req.query.dateTo || req.query.to || defaultTo).trim();
  const branchId = String(req.query.branchId || '').trim();

  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
    return res.status(400).json({ success: false, message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.' });
  }

  if (dateFrom > dateTo) {
    return res.status(400).json({ success: false, message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.' });
  }

  const cacheKey = `${dateFrom}|${dateTo}|${branchId || 'all'}`;
  const cached = reportCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < REPORT_CACHE_TTL_MS) {
    return res.status(200).json({
      ...cached.payload,
      cache: { hit: true, ttlMs: REPORT_CACHE_TTL_MS }
    });
  }

  try {
    const branches = branchId
      ? [{ store: getStoreNameByBranchId(branchId), branchId }]
      : listBranches();

    const result = await getCustomers({
      createdFrom: `${dateFrom}T00:00:00`,
      createdUntil: `${dateTo}T23:59:59`,
      registeredInBranchId: branchId || ''
    });

    const allCustomers = result.customers || [];
    const filteredCustomers = allCustomers.filter((customer) => isInPeriod(customer, dateFrom, dateTo));
    const rows = aggregateByBranch(filteredCustomers, branches, dateFrom, dateTo);
    const totals = summarizeCustomers(filteredCustomers);

    const payload = {
      success: true,
      dateFrom,
      dateTo,
      mode: 'safe-server-filter-local-aggregate',
      sourceCustomerCount: allCustomers.length,
      totals,
      rows,
      errors: []
    };

    reportCache.set(cacheKey, { createdAt: Date.now(), payload });

    return res.status(200).json({
      ...payload,
      cache: { hit: false, ttlMs: REPORT_CACHE_TTL_MS }
    });
  } catch (error) {
    console.error('Customer weekly report safe fallback:', error);
    return res.status(200).json(fallbackPayload({
      dateFrom,
      dateTo,
      branchId,
      message: error.message || 'Klantinschrijvingen konden niet worden opgehaald.'
    }));
  }
}
