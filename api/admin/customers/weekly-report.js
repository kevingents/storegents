import { getCustomers } from '../../../lib/srs-customers-client.js';
import { listBranches, getStoreNameByBranchId } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const REPORT_CACHE_TTL_MS = Math.max(1000, Number(process.env.CUSTOMERS_WEEKLY_REPORT_CACHE_MS || 5 * 60 * 1000) || 5 * 60 * 1000);
const reportCache = new Map();

function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.query.token ||
    req.body?.adminToken ||
    req.body?.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken) && token === adminToken;
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function startOfWeek(date = new Date()) { const d = new Date(date); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return d; }
function endOfWeek(date = new Date()) { const end = startOfWeek(date); end.setDate(end.getDate() + 6); return end; }
function isIsoDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }

function customerDate(customer) {
  return String(customer.createdAt || customer.CreatedAt || customer.dateCreated || customer.creationDate || customer.created || '').slice(0, 10);
}

function customerBranchId(customer) {
  return String(customer.registeredInBranchId || customer.RegisteredInBranchId || customer.branchId || customer.BranchId || customer.storeBranchId || '').trim();
}

function customerEmail(customer) {
  return String(customer.email || customer.Email || customer.emailAddress || customer.EmailAddress || '').trim();
}

function isInPeriod(customer, dateFrom, dateTo) {
  const date = customerDate(customer);
  if (!date) return false;
  return date >= dateFrom && date <= dateTo;
}

function summarizeCustomers(customers) {
  const total = customers.length;
  const withEmail = customers.filter((customer) => customerEmail(customer)).length;
  const mailingOptIn = customers.filter((customer) => String(customer.allowMailings || customer.AllowMailings || '').toLowerCase() === 'true').length;
  const loyaltyOptIn = customers.filter((customer) => String(customer.receivesLoyaltyPoints || customer.ReceivesLoyaltyPoints || '').toLowerCase() === 'true').length;
  const withReceipt = customers.filter((customer) => Number(customer.receiptCount || customer.ReceiptCount || 0) > 0).length;
  const receiptCount = customers.reduce((sum, customer) => sum + (Number(customer.receiptCount || customer.ReceiptCount || 0) || 0), 0);
  const withoutEmail = Math.max(0, total - withEmail);
  const withoutReceipt = Math.max(0, total - withReceipt);

  return {
    total,
    totalCustomers: total,
    newCustomers: total,
    withEmail,
    withoutEmail,
    withReceipt,
    withoutReceipt,
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
      const branchValue = customerBranchId(customer);
      return String(branchValue || '') === String(branch.branchId || '');
    });

    return {
      store: branch.store,
      branchName: branch.store,
      branchId: branch.branchId,
      ...summarizeCustomers(branchCustomers),
      customers: branchCustomers
    };
  });
}

function fallbackPayload({ dateFrom, dateTo, branchId, message }) {
  const branches = branchId ? [{ store: getStoreNameByBranchId(branchId), branchId }] : listBranches();
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
    rows: branches.map((branch) => ({ store: branch.store, branchName: branch.store, branchId: branch.branchId, ...summarizeCustomers([]), customers: [] })),
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
  const refresh = String(req.query.refresh || '') === '1' || String(req.query.refresh || '') === 'true';

  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) return res.status(400).json({ success: false, message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.' });
  if (dateFrom > dateTo) return res.status(400).json({ success: false, message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.' });

  const cacheKey = `${dateFrom}|${dateTo}|${branchId || 'all'}`;
  const cached = reportCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.createdAt < REPORT_CACHE_TTL_MS) return res.status(200).json({ ...cached.payload, cache: { hit: true, ttlMs: REPORT_CACHE_TTL_MS } });

  try {
    const branches = branchId ? [{ store: getStoreNameByBranchId(branchId), branchId }] : listBranches();
    const result = await getCustomers({});
    const allCustomers = result.customers || [];
    const filteredCustomers = allCustomers.filter((customer) => isInPeriod(customer, dateFrom, dateTo));
    const rows = aggregateByBranch(filteredCustomers, branches, dateFrom, dateTo);
    const totals = summarizeCustomers(filteredCustomers);
    const payload = { success: true, dateFrom, dateTo, mode: 'safe-all-customers-server-filter-local-aggregate', sourceCustomerCount: allCustomers.length, totals, rows, errors: [] };
    reportCache.set(cacheKey, { createdAt: Date.now(), payload });
    return res.status(200).json({ ...payload, cache: { hit: false, ttlMs: REPORT_CACHE_TTL_MS } });
  } catch (error) {
    console.error('Customer weekly report safe fallback:', error);
    return res.status(200).json(fallbackPayload({ dateFrom, dateTo, branchId, message: error.message || 'Klantinschrijvingen konden niet worden opgehaald.' }));
  }
}
