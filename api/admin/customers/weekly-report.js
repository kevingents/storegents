import { getCustomers, getTransactions } from '../../../lib/srs-customers-client.js';
import { listBranches, getStoreNameByBranchId, getBranchIdByStore } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { getTargetsForPeriod, attachTargetsToRow, countReceiptsByBranch } from '../../../lib/customer-target-helpers.js';

const REPORT_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.CUSTOMERS_WEEKLY_REPORT_CACHE_MS || 10 * 60 * 1000) || 10 * 60 * 1000
);

const SOURCE_TIMEOUT_MS = Math.max(
  5000,
  Number(process.env.CUSTOMERS_REPORT_SOURCE_TIMEOUT_MS || 18000) || 18000
);

const GLOBAL_TIMEOUT_MS = Math.max(
  20000,
  Number(process.env.CUSTOMERS_REPORT_GLOBAL_TIMEOUT_MS || 52000) || 52000
);

const CUSTOMER_CHUNK_DAYS = Math.max(
  1,
  Number(process.env.CUSTOMERS_REPORT_CHUNK_DAYS || 1) || 1
);

const CUSTOMER_CHUNK_CONCURRENCY = Math.max(
  1,
  Number(process.env.CUSTOMERS_REPORT_CHUNK_CONCURRENCY || 4) || 4
);

const RECEIPT_CUSTOMER_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.CUSTOMERS_RECEIPT_CUSTOMER_TIMEOUT_MS || 9000) || 9000
);

const RECEIPT_CUSTOMER_CONCURRENCY = Math.max(
  1,
  Number(process.env.CUSTOMERS_RECEIPT_CUSTOMER_CONCURRENCY || 5) || 5
);

const RECEIPT_CUSTOMER_GLOBAL_TIMEOUT_MS = Math.max(
  10000,
  Number(process.env.CUSTOMERS_RECEIPT_CUSTOMER_GLOBAL_TIMEOUT_MS || 50000) || 50000
);

const MAX_DEEP_RECEIPT_CUSTOMERS = Math.max(
  1,
  Number(process.env.CUSTOMERS_MAX_DEEP_RECEIPT_CUSTOMERS || 90) || 90
);

const reportCache = new Map();

function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;

  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();

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
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  return Boolean(adminToken && token && token === adminToken);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseIsoDate(dateString) {
  const [year, month, day] = String(dateString || '').split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function addDays(dateString, days) {
  const date = parseIsoDate(dateString);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
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
    customer.createdAt ||
    customer.CreatedAt ||
    customer.created_at ||
    customer.dateCreated ||
    customer.DateCreated ||
    customer.creationDate ||
    customer.CreationDate ||
    customer.created ||
    customer.Created ||
    customer.registeredAt ||
    customer.RegisteredAt ||
    customer.date ||
    customer.Date
  );
}

function customerBranchId(customer) {
  return String(
    customer.registeredInBranchId ||
    customer.RegisteredInBranchId ||
    customer.branchId ||
    customer.BranchId ||
    customer.storeBranchId ||
    customer.StoreBranchId ||
    ''
  ).trim();
}

function customerId(customer) {
  return String(
    customer.customerId ||
    customer.CustomerId ||
    customer.customerID ||
    customer.CustomerID ||
    customer.id ||
    ''
  ).trim();
}

function customerEmail(customer) {
  return String(
    customer.email ||
    customer.Email ||
    customer.emailAddress ||
    customer.EmailAddress ||
    ''
  ).trim();
}

function customerName(customer) {
  return String(
    customer.name ||
    customer.fullName ||
    customer.customerName ||
    [customer.firstName || customer.FirstName, customer.lastName || customer.LastName].filter(Boolean).join(' ') ||
    ''
  ).trim();
}

function isTrue(value) {
  return ['true', '1', 'yes', 'ja'].includes(String(value || '').toLowerCase());
}

function isInPeriod(customer, dateFrom, dateTo) {
  const date = customerDate(customer);
  if (!date) return false;
  return date >= dateFrom && date <= dateTo;
}

function transactionCustomerId(transaction) {
  return String(
    transaction.customerId ||
    transaction.CustomerId ||
    transaction.customerID ||
    transaction.CustomerID ||
    ''
  ).trim();
}

function transactionBranchId(transaction) {
  return String(transaction.branchId || transaction.BranchId || '').trim();
}

function transactionReceipt(transaction) {
  return String(
    transaction.receiptNr ||
    transaction.ReceiptNr ||
    transaction.receiptNo ||
    transaction.ReceiptNo ||
    transaction.orderNr ||
    transaction.OrderNr ||
    transaction.orderNo ||
    transaction.OrderNo ||
    ''
  ).trim();
}

function transactionDate(transaction) {
  return normalizeDate(
    transaction.dateTime ||
    transaction.DateTime ||
    transaction.createdAt ||
    transaction.CreatedAt ||
    transaction.date ||
    transaction.Date
  );
}

function hasUsableReceipt(transaction) {
  return Boolean(transactionReceipt(transaction));
}

function withTimeout(promise, ms, label) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout na ${ms}ms`)), ms);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function makeDateChunks(dateFrom, dateTo, chunkDays = 1) {
  const chunks = [];
  let cursor = dateFrom;

  while (cursor <= dateTo) {
    const end = addDays(cursor, chunkDays - 1);
    const chunkTo = end > dateTo ? dateTo : end;

    chunks.push({
      from: cursor,
      to: chunkTo,
      createdFrom: `${cursor}T00:00:00`,
      createdUntil: `${chunkTo}T23:59:59`
    });

    cursor = addDays(chunkTo, 1);
  }

  return chunks;
}

async function runLimited(items, concurrency, worker, shouldStop) {
  const results = [];
  let index = 0;

  async function runner() {
    while (index < items.length) {
      if (shouldStop && shouldStop()) break;

      const currentIndex = index;
      index += 1;

      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const runners = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => runner()
  );

  await Promise.all(runners);

  return results;
}

function dedupeCustomers(customers) {
  const map = new Map();

  for (const customer of customers || []) {
    const id = customerId(customer);
    const key = id || `${customerName(customer)}|${customerEmail(customer)}|${customerDate(customer)}`;

    if (!key) continue;
    if (!map.has(key)) map.set(key, customer);
  }

  return Array.from(map.values());
}

async function loadCustomersForPeriod(dateFrom, dateTo) {
  const startedAt = Date.now();
  const chunks = makeDateChunks(dateFrom, dateTo, CUSTOMER_CHUNK_DAYS);
  const errors = [];
  const customers = [];

  await runLimited(
    chunks,
    CUSTOMER_CHUNK_CONCURRENCY,
    async (chunk) => {
      if (Date.now() - startedAt > GLOBAL_TIMEOUT_MS) {
        errors.push(`customers-period: globale timeout na ${GLOBAL_TIMEOUT_MS}ms`);
        return;
      }

      try {
        const result = await withTimeout(
          getCustomers({
            createdFrom: chunk.createdFrom,
            createdUntil: chunk.createdUntil
          }),
          SOURCE_TIMEOUT_MS,
          `customers ${chunk.from} t/m ${chunk.to}`
        );

        const list = Array.isArray(result?.customers) ? result.customers : [];
        customers.push(...list);
      } catch (error) {
        errors.push(`customers ${chunk.from} t/m ${chunk.to}: ${error.message || String(error)}`);
      }
    },
    () => Date.now() - startedAt > GLOBAL_TIMEOUT_MS
  );

  const uniqueCustomers = dedupeCustomers(customers);

  return {
    customers: uniqueCustomers,
    sourceMode: errors.length
      ? 'period-chunk-filter-srs-local-branch-aggregate-degraded'
      : 'period-chunk-filter-srs-local-branch-aggregate',
    errors
  };
}

async function loadTransactionsForPeriod(dateFrom, dateTo) {
  const from = `${dateFrom}T00:00:00`;
  const until = `${dateTo}T23:59:59`;

  const result = await withTimeout(
    getTransactions({ from, until }),
    SOURCE_TIMEOUT_MS,
    'transactions-period'
  );

  return Array.isArray(result?.transactions) ? result.transactions : [];
}

function buildReceiptMap(transactions) {
  const map = new Map();

  for (const transaction of transactions || []) {
    const id = transactionCustomerId(transaction);
    if (!id) continue;
    if (!hasUsableReceipt(transaction)) continue;

    const next = {
      customerId: id,
      receiptNr: transactionReceipt(transaction),
      branchId: transactionBranchId(transaction),
      dateTime: transaction.dateTime || transaction.DateTime || '',
      date: transactionDate(transaction),
      orderNr: String(
        transaction.orderNr ||
        transaction.OrderNr ||
        transaction.orderNo ||
        transaction.OrderNo ||
        ''
      ).trim(),
      source: 'period-transactions'
    };

    const existing = map.get(id);

    if (!existing) {
      map.set(id, next);
      continue;
    }

    const existingDate = String(existing.date || '');
    const nextDate = String(next.date || '');

    if (nextDate && (!existingDate || nextDate < existingDate)) {
      map.set(id, next);
    }
  }

  return map;
}

async function enrichReceiptMapWithCustomerTransactions(customers, receiptMap, errors) {
  const list = (customers || []).filter((customer) => {
    const id = customerId(customer);
    return id && !receiptMap.has(id);
  });

  const stats = {
    attempted: 0,
    matched: 0,
    errors: 0,
    skipped: 0
  };

  const failures = new Map();
  const processedIds = new Set();

  if (!list.length) return { stats, failures };

  const startedAt = Date.now();

  await runLimited(
    list,
    RECEIPT_CUSTOMER_CONCURRENCY,
    async (customer) => {
      const id = customerId(customer);
      if (!id) return;

      processedIds.add(id);

      if (Date.now() - startedAt > RECEIPT_CUSTOMER_GLOBAL_TIMEOUT_MS) {
        stats.skipped += 1;
        failures.set(id, {
          status: 'Controle mislukt',
          reason: `globale boncontrole-timeout na ${RECEIPT_CUSTOMER_GLOBAL_TIMEOUT_MS}ms`
        });
        return;
      }

      stats.attempted += 1;

      try {
        /*
          Belangrijk: hier GEEN periode meesturen.
          In SRS werkt de klantprofielroute betrouwbaar met alleen CustomerId.
          Daarmee verdwijnt een fout automatisch zodra een bon later alsnog wordt gekoppeld.
        */
        const result = await withTimeout(
          getTransactions({ customerId: id }),
          RECEIPT_CUSTOMER_TIMEOUT_MS,
          `transactions customer ${id}`
        );

        const transactions = Array.isArray(result?.transactions) ? result.transactions : [];
        const customerReceiptMap = buildReceiptMap(transactions);
        const receipt = customerReceiptMap.get(id);

        if (receipt) {
          receiptMap.set(id, {
            ...receipt,
            source: 'customer-transactions'
          });
          stats.matched += 1;
        }
      } catch (error) {
        stats.errors += 1;
        const reason = error.message || String(error);
        failures.set(id, {
          status: 'Controle mislukt',
          reason
        });
        errors.push(`transactions customer ${id}: ${reason}`);
      }
    },
    () => Date.now() - startedAt > RECEIPT_CUSTOMER_GLOBAL_TIMEOUT_MS
  );

  for (const customer of list) {
    const id = customerId(customer);
    if (!id) continue;
    if (processedIds.has(id) || receiptMap.has(id) || failures.has(id)) continue;
    stats.skipped += 1;
    failures.set(id, {
      status: 'Controle mislukt',
      reason: 'boncontrole overgeslagen door timeout of limiet'
    });
  }

  return { stats, failures };
}

function normalizeCustomer(customer, receiptMap, receiptCheckAvailable, deepReceiptAttempted, receiptFailureMap) {
  const id = customerId(customer);
  const receiptInfo = receiptMap.get(id) || null;
  const receiptFailure = receiptFailureMap?.get(id) || null;
  const receiptUnknown = !receiptInfo && Boolean(receiptFailure || (!deepReceiptAttempted && !receiptCheckAvailable));

  return {
    ...customer,
    customerId: id,
    createdAt: customerDate(customer),
    branchId: customerBranchId(customer),
    email: customerEmail(customer),
    name: customerName(customer),

    receiptCheckAvailable: Boolean(receiptCheckAvailable || deepReceiptAttempted),
    hasReceipt: Boolean(receiptInfo),
    receiptUnknown,
    receiptError: receiptFailure?.reason || '',

    receiptNr: receiptInfo?.receiptNr || '',
    receiptBranchId: receiptInfo?.branchId || '',
    receiptDate: receiptInfo?.dateTime || '',
    receiptOrderNr: receiptInfo?.orderNr || '',
    receiptSource: receiptInfo?.source || '',
    receiptStatus: receiptUnknown
      ? 'Controle mislukt'
      : receiptInfo
        ? 'Met bon'
        : 'Zonder bon'
  };
}

function summarizeCustomers(customers) {
  const list = Array.isArray(customers) ? customers : [];

  const total = list.length;
  const withEmail = list.filter((customer) => customerEmail(customer)).length;
  const withoutEmail = Math.max(0, total - withEmail);

  const knownReceiptList = list.filter((customer) => !customer.receiptUnknown);
  const withReceipt = knownReceiptList.filter((customer) => Boolean(customer.hasReceipt)).length;
  const withoutReceipt = knownReceiptList.filter((customer) => !customer.hasReceipt).length;
  const unknownReceipt = list.filter((customer) => customer.receiptUnknown).length;

  const mailingOptIn = list.filter((customer) =>
    isTrue(customer.allowMailings ?? customer.AllowMailings)
  ).length;

  const loyaltyOptIn = list.filter((customer) =>
    isTrue(customer.receivesLoyaltyPoints ?? customer.ReceivesLoyaltyPoints)
  ).length;

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

    unknownReceipt,
    unknownBon: unknownReceipt,
    customersUnknownReceipt: unknownReceipt,

    receiptCount: withReceipt,
    totalReceipts: withReceipt,
    receipts: withReceipt,

    mailingOptIn,
    loyaltyOptIn,

    emailRate: total ? Math.round((withEmail / total) * 100) : 0,
    receiptConversionRate: total ? Math.round((withReceipt / total) * 100) : 0,
    customerReceiptRate: total ? Math.round((withReceipt / total) * 100) : 0,
    mailingOptInRate: total ? Math.round((mailingOptIn / total) * 100) : 0,
    loyaltyOptInRate: total ? Math.round((loyaltyOptIn / total) * 100) : 0
  };
}

function getCustomersInScope(customers, branches, dateFrom, dateTo) {
  const branchIds = new Set((branches || []).map((branch) => String(branch.branchId || '').trim()).filter(Boolean));

  return (customers || []).filter((customer) => {
    if (!isInPeriod(customer, dateFrom, dateTo)) return false;
    if (!branchIds.size) return true;
    return branchIds.has(customerBranchId(customer));
  });
}

function aggregateByBranch(customers, branches, dateFrom, dateTo, receiptMap, receiptCheckAvailable, deepReceiptAttempted, receiptFailureMap = new Map()) {
  const inRange = (customers || [])
    .filter((customer) => isInPeriod(customer, dateFrom, dateTo))
    .map((customer) => normalizeCustomer(customer, receiptMap, receiptCheckAvailable, deepReceiptAttempted, receiptFailureMap));

  return branches.map((branch) => {
    const branchCustomers = inRange.filter((customer) =>
      String(customer.branchId || '') === String(branch.branchId || '')
    );

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

function resolveBranches({ branchId, store }) {
  const selectedBranchId = String(branchId || getBranchIdByStore(store) || '').trim();

  if (selectedBranchId) {
    return [{
      store: getStoreNameByBranchId(selectedBranchId),
      branchId: selectedBranchId
    }];
  }

  return listBranches();
}

async function buildPayload({
  dateFrom,
  dateTo,
  branchId,
  store,
  rows,
  sourceCustomerCount,
  sourceTransactionCount,
  sourceMode,
  errors,
  cacheHit = false,
  receiptCheck = null,
  transactions = []
}) {
  const allCustomers = rows.flatMap((row) => row.customers || []);
  const totals = summarizeCustomers(allCustomers);
  const blockingErrors = (errors || []).filter((message) => !String(message || '').startsWith('transactions customer '));
  const degraded = Boolean(blockingErrors.length || totals.unknownBon > 0);

  /* Targets + percentages joinen.
     - Load targets pro-rata over de periode per store
     - Tel totale bonnen per branchId vanuit transactions array
     - Verrijk elke row met percentages */
  const storeNames = rows.map((r) => r.store).filter(Boolean);
  let targetsByStore = {};
  let receiptsByBranch = {};
  try {
    targetsByStore = await getTargetsForPeriod(storeNames, dateFrom, dateTo);
  } catch (err) {
    console.warn('[weekly-report] getTargetsForPeriod failed:', err.message);
  }
  try {
    receiptsByBranch = countReceiptsByBranch(transactions);
  } catch (err) {
    console.warn('[weekly-report] countReceiptsByBranch failed:', err.message);
  }

  for (const row of rows) {
    const target = targetsByStore[row.store] || { inschrijvingen: 0, metBon: 0, metEmail: 0 };
    const totalReceipts = receiptsByBranch[row.branchId] || 0;
    attachTargetsToRow(row, target, totalReceipts);
  }

  /* Totals krijgen aggregeerde targets + percentages */
  const totalTargets = {
    inschrijvingen: rows.reduce((s, r) => s + (r.targetInschrijvingen || 0), 0),
    metBon: rows.reduce((s, r) => s + (r.targetMetBon || 0), 0),
    metEmail: rows.reduce((s, r) => s + (r.targetMetEmail || 0), 0)
  };
  const totalReceiptsAll = rows.reduce((s, r) => s + (r.totalReceiptsInStore || 0), 0);
  totals.targetInschrijvingen = totalTargets.inschrijvingen;
  totals.targetMetBon = totalTargets.metBon;
  totals.targetMetEmail = totalTargets.metEmail;
  totals.totalReceipts = totalReceiptsAll;
  /* Computed totals (gebruik dezelfde calcPct als per-store) */
  const calcPct = (a, t) => (t > 0 ? Math.round((Number(a) / t) * 100) : null);
  totals.pctInschrijvingenVsTarget = calcPct(totals.totalNew || totals.total, totalTargets.inschrijvingen);
  totals.pctMetBonVsTarget = calcPct(totals.withBon, totalTargets.metBon);
  totals.pctMetEmailVsTarget = calcPct(totals.withEmail, totalTargets.metEmail);
  totals.pctInschrijvingenVsBons = calcPct(totals.totalNew || totals.total, totalReceiptsAll);

  return {
    success: true,
    degraded,
    dateFrom,
    dateTo,
    store: store || '',
    branchId: branchId || '',
    mode: sourceMode || 'customers-report-with-receipt-check',
    sourceMode,
    sourceCustomerCount,
    sourceTransactionCount,
    receiptCheck,
    totals,
    rows,
    targetsByStore,
    errors: (errors || []).map((message) => ({ message })),
    warnings: errors || [],
    note: degraded
      ? 'Klantinschrijvingen zijn gedeeltelijk geladen. Boncontrole kon deels niet worden afgerond.'
      : 'Klantinschrijvingen en bonkoppelingen opgehaald.',
    cache: {
      hit: cacheHit,
      ttlMs: REPORT_CACHE_TTL_MS
    }
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

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

  const defaultFrom = isoDate(startOfWeek());
  const defaultTo = isoDate(endOfWeek());

  const dateFrom = String(req.query.dateFrom || req.query.from || defaultFrom).trim();
  const dateTo = String(req.query.dateTo || req.query.to || defaultTo).trim();
  const store = String(req.query.store || '').trim();
  const branchId = String(req.query.branchId || getBranchIdByStore(store) || '').trim();

  const refresh =
    String(req.query.refresh || '') === '1' ||
    String(req.query.refresh || '') === 'true';

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

  const cacheKey = `${dateFrom}|${dateTo}|${branchId || 'all'}|${store || ''}|deep-receipts-v2`;
  const cached = reportCache.get(cacheKey);

  if (!refresh && cached && Date.now() - cached.createdAt < REPORT_CACHE_TTL_MS) {
    return res.status(200).json({
      ...cached.payload,
      cache: {
        hit: true,
        ttlMs: REPORT_CACHE_TTL_MS
      }
    });
  }

  const branches = resolveBranches({ branchId, store });
  const errors = [];

  try {
    const customerResult = await loadCustomersForPeriod(dateFrom, dateTo);

    errors.push(...(customerResult.errors || []));

    let transactions = [];
    let periodReceiptCheckAvailable = false;

    try {
      transactions = await loadTransactionsForPeriod(dateFrom, dateTo);
      periodReceiptCheckAvailable = true;
    } catch (error) {
      errors.push(`transactions-period: ${error.message || String(error)}`);
      transactions = [];
      periodReceiptCheckAvailable = false;
    }

    const receiptMap = buildReceiptMap(transactions);
    const scopedCustomers = getCustomersInScope(customerResult.customers, branches, dateFrom, dateTo);
    const forceDeep = String(req.query.deepReceipts || req.query.deep || '') === '1' || String(req.query.deepReceipts || req.query.deep || '') === 'true';
    const isSingleStore = Boolean(branchId || store);
    const shouldDeepCheck = isSingleStore || forceDeep || scopedCustomers.length <= MAX_DEEP_RECEIPT_CUSTOMERS;

    let deepReceiptAttempted = false;
    let receiptFailureMap = new Map();
    let receiptCheck = {
      periodAvailable: periodReceiptCheckAvailable,
      deepAttempted: false,
      deepReason: shouldDeepCheck ? 'enabled' : `skipped-more-than-${MAX_DEEP_RECEIPT_CUSTOMERS}-customers`,
      scopedCustomerCount: scopedCustomers.length,
      attempted: 0,
      matched: 0,
      errors: 0,
      skipped: 0
    };

    if (shouldDeepCheck) {
      deepReceiptAttempted = true;
      const deepResult = await enrichReceiptMapWithCustomerTransactions(scopedCustomers, receiptMap, errors);
      receiptFailureMap = deepResult.failures || new Map();
      receiptCheck = {
        ...receiptCheck,
        deepAttempted: true,
        ...(deepResult.stats || {})
      };
    }

    const rows = aggregateByBranch(
      customerResult.customers,
      branches,
      dateFrom,
      dateTo,
      receiptMap,
      periodReceiptCheckAvailable,
      deepReceiptAttempted,
      receiptFailureMap
    );

    const payload = await buildPayload({
      dateFrom,
      dateTo,
      branchId,
      store,
      rows,
      sourceCustomerCount: customerResult.customers.length,
      sourceTransactionCount: transactions.length,
      sourceMode: `${customerResult.sourceMode}-with-deep-receipts-v2`,
      errors,
      receiptCheck,
      transactions
    });

    reportCache.set(cacheKey, {
      createdAt: Date.now(),
      payload
    });

    if (reportCache.size > 100) {
      reportCache.delete(reportCache.keys().next().value);
    }

    return res.status(200).json(payload);
  } catch (error) {
    const message = error.message || 'Klantinschrijvingen konden niet worden opgehaald.';
    const rows = fallbackRows(branches);

    const payload = await buildPayload({
      dateFrom,
      dateTo,
      branchId,
      store,
      rows,
      sourceCustomerCount: 0,
      sourceTransactionCount: 0,
      sourceMode: 'fatal-safe-empty-fallback',
      errors: [message],
      transactions: []
    });

    return res.status(200).json(payload);
  }
}
