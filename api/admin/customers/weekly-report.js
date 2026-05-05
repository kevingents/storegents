import { getCustomers } from '../../../lib/srs-customers-client.js';
import { listBranches, getStoreNameByBranchId, getBranchIdByStore } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const REPORT_CACHE_TTL_MS = Math.max(1000, Number(process.env.CUSTOMERS_WEEKLY_REPORT_CACHE_MS || 10 * 60 * 1000) || 10 * 60 * 1000);
const SOURCE_TIMEOUT_MS = Math.max(5000, Number(process.env.CUSTOMERS_REPORT_SOURCE_TIMEOUT_MS || 30000) || 30000);
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
  return Boolean(adminToken && token && token === adminToken);
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function startOfWeek(date = new Date()) { const d = new Date(date); const day = d.getDay() || 7; d.setDate(d.getDate() - day + 1); return d; }
function endOfWeek(date = new Date()) { const end = startOfWeek(date); end.setDate(end.getDate() + 6); return end; }
function isIsoDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }

function normalizeDate(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const direct = raw.slice(0, 10);
  if (isIsoDate(direct)) return direct;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? '' : isoDate(parsed);
}

function customerDate(customer) {
  return normalizeDate(
    customer.createdAt || customer.CreatedAt || customer.created_at || customer.dateCreated ||
    customer.DateCreated || customer.creationDate || customer.CreationDate || customer.created ||
    customer.Created || customer.registeredAt || customer.RegisteredAt || customer.date || customer.Date
  );
}

function customerBranchId(customer) {
  return String(
    customer.registeredInBranchId || customer.RegisteredInBranchId || customer.branchId ||
    customer.BranchId || customer.storeBranchId || customer.StoreBranchId || ''
  ).trim();
}

function customerEmail(customer) {
  return String(customer.email || customer.Email || customer.emailAddress || customer.EmailAddress || '').trim();
}

function customerName(customer) {
  return String(
    customer.name || customer.fullName || customer.customerName ||
    [customer.firstName || customer.FirstName, customer.lastName || customer.LastName].filter(Boolean).join(' ') || ''
  ).trim();
}

function receiptCount(customer) {
  return Number(customer.receiptCount || customer.ReceiptCount || customer.receipts || customer.TotalReceipts || 0) || 0;
}

function isTrue(value) {
  return ['true', '1', 'yes', 'ja'].includes(String(value || '').toLowerCase());
}

function isInPeriod(customer, dateFrom, dateTo) {
  const date = customerDate(customer);
  if (!date) return false;
  return date >= dateFrom && date <= dateTo;
}

function summarizeCustomers(customers) {
  const list = Array.isArray(customers) ? customers : [];
  const total = list.length;
  const withEmail = list.filter((customer) => customerEmail(customer)).length;
  const mailingOptIn = list.filter((customer) => isTrue(customer.allowMailings ?? customer.AllowMailings)).length;
  const loyaltyOptIn = list.filter((customer) => isTrue(customer.receivesLoyaltyPoints ?? customer.ReceivesLoyaltyPoints)).length;
  const withReceipt = list.filter((customer) => receiptCount(customer) > 0).length;
  const receipts = list.reduce((sum, customer) => sum + receiptCount(customer), 0);
  const withoutEmail = Math.max(0, total - withEmail);
  const withoutReceipt = Math.max(0, total - withReceipt);

  return {
    total,
    totalCustomers: total,
    customerCount: total,
    newCustomers: total,
    customers: total,
    withEmail,
    emailCount: withEmail,
    customersWithEmail: withEmail,
    withoutEmail,
    noEmailCount: withoutEmail,
    customersWithoutEmail: withoutEmail,
    withReceipt,
    withBon: withReceipt,
    customersWithReceipt: withReceipt,
    withoutReceipt,
    withoutBon: withoutReceipt,
    customersWithoutReceipt: withoutReceipt,
    receiptCount: receipts,
    totalReceipts: receipts,
    receipts,
    mailingOptIn,
    loyaltyOptIn,
    emailRate: total ? Math.round((withEmail / total) * 100) : 0,
    receiptConversionRate: total ? Math.round((withReceipt / total) * 100) : 0,
    customerReceiptRate: total ? Math.round((withReceipt / total) * 100) : 0,
    mailingOptInRate: total ? Math.round((mailingOptIn / total) * 100) : 0,
    loyaltyOptInRate: total ? Math.round((loyaltyOptIn / total) * 100) : 0
  };
}

function normalizeCustomer(customer) {
  return {
    ...customer,
    createdAt: customerDate(customer),
    branchId: customerBranchId(customer),
    email: customerEmail(customer),
    name: customerName(customer),
    receiptCount: receiptCount(customer)
  };
}

function aggregateByBranch(customers, branches, dateFrom, dateTo) {
  const inRange = (customers || []).map(normalizeCustomer).filter((customer) => isInPeriod(customer, dateFrom, dateTo));
  return branches.map((branch) => {
    const branchCustomers = inRange.filter((customer) => String(customer.branchId || '') === String(branch.branchId || ''));
    return {
      store: branch.store,
      branchName: branch.store,
      branchId: branch.branchId,
      ...summarizeCustomers(branchCustomers),
      customers: branchCustomers
    };
  });
}

function fallbackRows(branches) {
  return branches.map((branch) => ({
    store: branch.store,
    branchName: branch.store,
    branchId: branch.branchId,
    ...summarizeCustomers([]),
    customers: []
  }));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout na ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function getCustomersForPeriod({ dateFrom, dateTo }) {
  const createdFrom = `${dateFrom}T00:00:00`;
  const createdUntil = `${dateTo}T23:59:59`;
  const errors = [];

  try {
    const result = await withTimeout(
      getCustomers({ createdFrom, createdUntil }),
      SOURCE_TIMEOUT_MS,
      'period-filter-srs-local-branch-aggregate'
    );
    const customers = Array.isArray(result?.customers) ? result.customers : [];
    return { customers, sourceMode: 'period-filter-srs-local-branch-aggregate', errors };
  } catch (error) {
    errors.push(`period-filter-srs-local-branch-aggregate: ${error.message || String(error)}`);
    return { customers: [], sourceMode: 'empty-after-source-errors', errors };
  }
}

function resolveBranches({ branchId, store }) {
  const selectedBranchId = String(branchId || getBranchIdByStore(store) || '').trim();
  if (selectedBranchId) return [{ store: getStoreNameByBranchId(selectedBranchId), branchId: selectedBranchId }];
  return listBranches();
}

function buildPayload({ dateFrom, dateTo, branchId, store, rows, sourceCustomerCount, sourceMode, errors, cacheHit = false }) {
  const allCustomers = rows.flatMap((row) => row.customers || []);
  const totals = summarizeCustomers(allCustomers);
  const degraded = Boolean(errors?.length) || sourceMode === 'empty-after-source-errors';
  return {
    success: true,
    degraded,
    dateFrom,
    dateTo,
    store: store || '',
    branchId: branchId || '',
    mode: sourceMode || 'customers-report',
    sourceMode,
    sourceCustomerCount,
    totals,
    rows,
    errors: (errors || []).map((message) => ({ message })),
    warnings: errors || [],
    note: degraded ? 'Klantinschrijvingen zijn gedeeltelijk of leeg geladen doordat SRS Customers traag of niet beschikbaar was.' : 'Klantinschrijvingen opgehaald.',
    cache: { hit: cacheHit, ttlMs: REPORT_CACHE_TTL_MS }
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
  const store = String(req.query.store || '').trim();
  const branchId = String(req.query.branchId || getBranchIdByStore(store) || '').trim();
  const refresh = String(req.query.refresh || '') === '1' || String(req.query.refresh || '') === 'true';

  if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) return res.status(400).json({ success: false, message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.' });
  if (dateFrom > dateTo) return res.status(400).json({ success: false, message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.' });

  const cacheKey = `${dateFrom}|${dateTo}|${branchId || 'all'}|${store || ''}`;
  const cached = reportCache.get(cacheKey);
  if (!refresh && cached && Date.now() - cached.createdAt < REPORT_CACHE_TTL_MS) return res.status(200).json({ ...cached.payload, cache: { hit: true, ttlMs: REPORT_CACHE_TTL_MS } });

  const branches = resolveBranches({ branchId, store });

  try {
    const result = await getCustomersForPeriod({ dateFrom, dateTo });
    const rows = aggregateByBranch(result.customers || [], branches, dateFrom, dateTo);
    const payload = buildPayload({ dateFrom, dateTo, branchId, store, rows, sourceCustomerCount: result.customers.length, sourceMode: result.sourceMode, errors: result.errors });
    reportCache.set(cacheKey, { createdAt: Date.now(), payload });
    if (reportCache.size > 100) reportCache.delete(reportCache.keys().next().value);
    return res.status(200).json(payload);
  } catch (error) {
    const message = error.message || 'Klantinschrijvingen konden niet worden opgehaald.';
    const rows = fallbackRows(branches);
    const payload = buildPayload({ dateFrom, dateTo, branchId, store, rows, sourceCustomerCount: 0, sourceMode: 'fatal-safe-empty-fallback', errors: [message] });
    return res.status(200).json(payload);
  }
}
