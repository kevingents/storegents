import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const CACHE_TTL = Math.max(1000, Number(process.env.OMNICHANNEL_SCOREBOARD_CACHE_MS || 120000) || 120000);
const cache = new Map();

const FALLBACK_BRANCHES = [
  'GENTS Almere',
  'GENTS Amersfoort',
  'GENTS Amsterdam',
  'GENTS Arnhem',
  'GENTS Breda',
  'GENTS Delft',
  'GENTS Den Bosch',
  'GENTS Enschede',
  'GENTS Groningen',
  'GENTS Hilversum',
  'GENTS Leiden',
  'GENTS Maastricht',
  'GENTS Nijmegen',
  'GENTS Rotterdam',
  'GENTS Tilburg',
  'GENTS Utrecht',
  'GENTS Zoetermeer',
  'GENTS Zwolle'
].map((store, index) => ({ store, branchId: String(index + 1) }));

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
    ''
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  return Boolean(adminToken && token && token === adminToken);
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function daysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return isoDate(date);
}

function isIsoDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

function clean(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

function storeKey(value) {
  return String(value || '').trim();
}

function branchKey(value) {
  return String(value || '').trim();
}

function matchesPeriod(value, from, to) {
  if (!value) return false;
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function pct(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  return t ? Math.round((p / t) * 100) : 0;
}

function fallbackScore({ customerRegistrations = 0, loyaltyOptIn = 0, voucherIssued = 0, voucherUsed = 0, labelCreated = 0 } = {}) {
  const customerTarget = 10;
  const loyaltyTarget = 8;
  const voucherTarget = 60;
  const labelTarget = 5;
  const scoreAgainstTarget = (value, target) => Math.max(0, Math.min(100, Math.round((Number(value || 0) / Number(target || 1)) * 100)));
  const customerScore = scoreAgainstTarget(customerRegistrations, customerTarget);
  const loyaltyScore = scoreAgainstTarget(loyaltyOptIn, loyaltyTarget);
  const voucherScore = voucherIssued ? scoreAgainstTarget(pct(voucherUsed, voucherIssued), voucherTarget) : 0;
  const labelScore = scoreAgainstTarget(labelCreated, labelTarget);
  const score = Math.round(customerScore * 0.35 + loyaltyScore * 0.25 + voucherScore * 0.25 + labelScore * 0.15);

  return {
    score,
    components: {
      customerRegistrations,
      loyaltyOptIn,
      customerScore,
      loyaltyScore,
      voucherScore,
      labelScore
    },
    targets: {
      customerTarget,
      loyaltyTarget,
      voucherTarget,
      labelTarget
    }
  };
}

async function safeImport(path, label, warnings) {
  try {
    return await import(path);
  } catch (error) {
    warnings.push(`${label}: ${error.message || 'module kon niet laden'}`);
    return {};
  }
}

async function safeCall(label, warnings, fallback, fn) {
  try {
    const value = await fn();
    return value === undefined || value === null ? fallback : value;
  } catch (error) {
    warnings.push(`${label}: ${error.message || 'kon niet worden opgehaald'}`);
    return fallback;
  }
}

function usedVoucher(status) {
  return [
    'afgeboekt_in_srs',
    'gebruikt_in_winkel_shopify_gedeactiveerd',
    'gebruikt_in_winkel_geen_shopify',
    'gebruikt_in_shopify'
  ].includes(String(status || ''));
}

function customersByBranch(customers, from, to) {
  const map = new Map();
  for (const customer of customers || []) {
    if (!matchesPeriod(customer.createdAt || customer.CreatedAt || customer.created_at, from, to)) continue;
    const key = branchKey(
      customer.registeredInBranchId ||
      customer.RegisteredInBranchId ||
      customer.branchId ||
      customer.BranchId ||
      customer.storeBranchId
    );
    if (!key) continue;

    const row = map.get(key) || { customerRegistrations: 0, loyaltyOptIn: 0, withEmail: 0 };
    row.customerRegistrations += 1;
    if (customer.email || customer.EmailAddress || customer.emailAddress) row.withEmail += 1;
    if (String(customer.receivesLoyaltyPoints || customer.ReceivesLoyaltyPoints).toLowerCase() === 'true') row.loyaltyOptIn += 1;
    map.set(key, row);
  }
  return map;
}

function vouchersByBranch(logs, from, to, storeToBranchId) {
  const map = new Map();
  for (const log of logs || []) {
    if (!matchesPeriod(log.createdAt || log.updatedAt || log.date, from, to)) continue;

    const key = branchKey(log.srsRedeemBranchId || storeToBranchId.get(storeKey(log.store)) || '');
    if (!key) continue;

    const row = map.get(key) || { voucherIssued: 0, voucherUsed: 0, voucherOpen: 0, voucherFailed: 0 };
    row.voucherIssued += 1;
    if (usedVoucher(log.status)) row.voucherUsed += 1;
    else if (clean(log.status).includes('mislukt') || clean(log.status).includes('failed')) row.voucherFailed += 1;
    else row.voucherOpen += 1;
    map.set(key, row);
  }
  return map;
}

function labelsByStore(labels, from, to) {
  const map = new Map();
  for (const label of labels || []) {
    if (!matchesPeriod(label.createdAt || label.updatedAt, from, to)) continue;

    const key = storeKey(label.senderStore || label.store);
    if (!key) continue;

    const row = map.get(key) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
    row.labelCreated += 1;
    if (label.trackingNumber || label.trackingUrl) row.labelWithTracking += 1;
    const status = clean(label.shipmentState || label.status);
    if (
      status.includes('verzonden') ||
      status.includes('delivered') ||
      status.includes('transit') ||
      status.includes('onderweg') ||
      status.includes('sorting') ||
      status.includes('gesorteerd') ||
      status.includes('handed') ||
      status.includes('ingeleverd') ||
      status.includes('accepted')
    ) {
      row.labelDeliveredOrTransit += 1;
    }
    map.set(key, row);
  }
  return map;
}

function cancellationLines(cancellations, cancellationLineRows) {
  if (typeof cancellationLineRows === 'function') return cancellationLineRows(cancellations || []);

  const rows = [];
  for (const item of cancellations || []) {
    const lines = Array.isArray(item.items) && item.items.length ? item.items : [{}];
    lines.forEach((line) => rows.push({ ...item, ...line, originalCancellation: item }));
  }
  return rows;
}

function opsByStore(rows, from, to) {
  const map = new Map();
  for (const row of rows || []) {
    if (!matchesPeriod(row.createdAt || row.updatedAt || row.date, from, to)) continue;

    const key = storeKey(row.store || 'SRS zonder filiaal');
    if (!key) continue;

    const status = clean(row.srsLineStatus || row.srsStatus || row.status || row.reason || row.srsSourceStatus);
    const amount = Number(row.amount || 0);
    const agg = map.get(key) || {
      unavailableLines: 0,
      cancelledLines: 0,
      failedLines: 0,
      totalProblemLines: 0,
      lostRevenueAmount: 0,
      unavailableAmount: 0,
      cancelledAmount: 0
    };

    if (status.includes('unavailable') || status.includes('niet leverbaar') || status.includes('not available')) {
      agg.unavailableLines += 1;
      agg.unavailableAmount += amount;
    }
    if (status.includes('cancelled') || status.includes('canceled') || status.includes('geannuleerd')) {
      agg.cancelledLines += 1;
      agg.cancelledAmount += amount;
    }
    if (status.includes('failed') || clean(row.error).includes('mislukt')) agg.failedLines += 1;

    agg.totalProblemLines += 1;
    agg.lostRevenueAmount += amount;
    map.set(key, agg);
  }
  return map;
}

function negativeStockByStore(report = {}) {
  const map = new Map();
  for (const row of report.byStore || []) {
    const key = storeKey(row.store);
    if (!key) continue;

    map.set(key, {
      negativeStockLines: Number(row.negativeLineCount || 0),
      negativeStockArticles: Number(row.negativeArticleCount || 0),
      negativeStockPieces: Math.abs(Number(row.negativePieces || 0)),
      negativeStockValue: Number(row.negativeValue || 0),
      negativeStockUpdatedAt: row.updatedAt || report.updatedAt || ''
    });
  }
  return map;
}

function stockScore({ unavailableLines = 0, cancelledLines = 0, failedLines = 0, negativeStockLines = 0, negativeStockPieces = 0, overdueExchangeCount = 0 } = {}) {
  const penalty = unavailableLines * 15 + cancelledLines * 10 + failedLines * 12 + negativeStockLines * 4 + negativeStockPieces * 2 + overdueExchangeCount * 5;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function opsScore({ unavailableLines = 0, cancelledLines = 0, failedLines = 0 } = {}) {
  return Math.max(0, Math.min(100, 100 - unavailableLines * 15 - cancelledLines * 8 - failedLines * 12));
}

function voucherQualityScore(v = {}) {
  if (!Number(v.voucherIssued || 0)) return 100;
  return Math.max(0, Math.min(100, pct(v.voucherUsed, v.voucherIssued) - Number(v.voucherFailed || 0) * 10));
}

function dataQualityText(details) {
  const parts = [];
  if (details.hasCustomerData) parts.push('klanten');
  if (details.hasVoucherData) parts.push('vouchers');
  if (details.hasLabelData) parts.push('labels');
  if (details.hasSrsOperationalData) parts.push('SRS');
  if (details.hasNegativeStockData) parts.push('min-voorraad');
  return parts.length ? parts.join(' + ') : 'geen data';
}

function buildRow(branch, maps, hasCustomerData, calculateOmnichannelScore) {
  const branchId = branchKey(branch.branchId);
  const store = storeKey(branch.store);
  const customers = maps.customers.get(branchId) || { customerRegistrations: 0, loyaltyOptIn: 0, withEmail: 0 };
  const vouchers = maps.vouchers.get(branchId) || { voucherIssued: 0, voucherUsed: 0, voucherOpen: 0, voucherFailed: 0 };
  const labels = maps.labels.get(store) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
  const ops = maps.ops.get(store) || { unavailableLines: 0, cancelledLines: 0, failedLines: 0, totalProblemLines: 0, lostRevenueAmount: 0, unavailableAmount: 0, cancelledAmount: 0 };
  const stock = maps.stock.get(store) || { negativeStockLines: 0, negativeStockArticles: 0, negativeStockPieces: 0, negativeStockValue: 0, negativeStockUpdatedAt: '' };

  const base = calculateOmnichannelScore({
    customerRegistrations: customers.customerRegistrations,
    loyaltyOptIn: customers.loyaltyOptIn,
    voucherIssued: vouchers.voucherIssued,
    voucherUsed: vouchers.voucherUsed,
    labelCreated: labels.labelCreated
  });

  const operationalScore = opsScore(ops);
  const stockQualityScore = stockScore({ ...ops, ...stock, overdueExchangeCount: 0 });
  const voucherScore = voucherQualityScore(vouchers);
  const labelScore = Number(base.components?.labelScore || 0);
  const score = Math.round(Number(base.score || 0) * 0.35 + stockQualityScore * 0.30 + voucherScore * 0.10 + operationalScore * 0.10 + labelScore * 0.15);

  const dataQualityDetails = {
    hasCustomerData,
    hasBranchCustomers: customers.customerRegistrations > 0,
    hasVoucherData: vouchers.voucherIssued > 0,
    hasLabelData: labels.labelCreated > 0,
    hasSrsOperationalData: ops.totalProblemLines > 0,
    hasNegativeStockData: stock.negativeStockLines > 0
  };

  const components = {
    ...(base.components || {}),
    customerRegistrations: customers.customerRegistrations,
    loyaltyOptIn: customers.loyaltyOptIn,
    labelCreated: labels.labelCreated,
    labelWithTracking: labels.labelWithTracking,
    labelDeliveredOrTransit: labels.labelDeliveredOrTransit,
    voucherIssued: vouchers.voucherIssued,
    voucherUsed: vouchers.voucherUsed,
    voucherOpen: vouchers.voucherOpen,
    voucherFailed: vouchers.voucherFailed,
    voucherUsageRate: pct(vouchers.voucherUsed, vouchers.voucherIssued),
    unavailableLines: ops.unavailableLines,
    unavailableAmount: ops.unavailableAmount,
    cancelledLines: ops.cancelledLines,
    cancelledAmount: ops.cancelledAmount,
    failedLines: ops.failedLines,
    totalProblemLines: ops.totalProblemLines,
    lostRevenueAmount: ops.lostRevenueAmount,
    negativeStockLines: stock.negativeStockLines,
    negativeStockArticles: stock.negativeStockArticles,
    negativeStockPieces: stock.negativeStockPieces,
    negativeStockValue: stock.negativeStockValue,
    negativeStockUpdatedAt: stock.negativeStockUpdatedAt,
    overdueExchangeCount: 0,
    operationalScore,
    stockQualityScore,
    voucherQualityScore: voucherScore
  };

  return {
    store,
    branchId,
    dataQuality: dataQualityText(dataQualityDetails),
    dataQualityDetails,
    score,
    legacyScore: Number(base.score || 0),
    operationalScore,
    stockQualityScore,
    voucherQualityScore: voucherScore,
    components,
    targets: base.targets || {},
    scoreExplanation: [
      `Basis ${Number(base.score || 0)}`,
      `Voorraad ${stockQualityScore}`,
      `Vouchers ${voucherScore}`,
      `SRS ${operationalScore}`,
      `Service ${labelScore}`,
      ops.unavailableLines ? `${ops.unavailableLines} niet leverbaar` : '',
      ops.cancelledLines ? `${ops.cancelledLines} geannuleerd` : '',
      stock.negativeStockLines ? `${stock.negativeStockLines} min-voorraad` : ''
    ].filter(Boolean).join(' · '),
    scoreBreakdown: {
      base: Number(base.score || 0),
      stockQuality: stockQualityScore,
      voucherQuality: voucherScore,
      srsOperationalQuality: operationalScore,
      serviceActivity: labelScore,
      weights: {
        customerLoyaltyBase: '35%',
        stockQuality: '30%',
        voucherQuality: '10%',
        srsOperationalQuality: '10%',
        sendcloudServiceActivity: '15%'
      },
      note: 'Weborders te laat tellen niet mee in voorraadkwaliteit.'
    }
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const warnings = [];

  try {
    const dateFrom = String(req.query.dateFrom || req.query.from || daysAgo(7)).trim();
    const dateTo = String(req.query.dateTo || req.query.to || isoDate(new Date())).trim();

    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      return res.status(400).json({ success: false, message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.' });
    }

    if (dateFrom > dateTo) {
      return res.status(400).json({ success: false, message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.' });
    }

    const cacheKey = `${dateFrom}|${dateTo}|resilient-v1`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL) {
      return res.status(200).json({
        ...cached.payload,
        cache: { hit: true, ttlMs: CACHE_TTL }
      });
    }

    const [branchMetrics, customersClient, voucherStore, labelStore, cancellationStore, stockStore] = await Promise.all([
      safeImport('../../../lib/branch-metrics.js', 'branch-metrics', warnings),
      safeImport('../../../lib/srs-customers-client.js', 'srs-customers-client', warnings),
      safeImport('../../../lib/voucher-log-store.js', 'voucher-log-store', warnings),
      safeImport('../../../lib/sendcloud-labels-store.js', 'sendcloud-labels-store', warnings),
      safeImport('../../../lib/order-cancellation-store.js', 'order-cancellation-store', warnings),
      safeImport('../../../lib/stock-negative-store.js', 'stock-negative-store', warnings)
    ]);

    const listBranches = typeof branchMetrics.listBranches === 'function' ? branchMetrics.listBranches : () => FALLBACK_BRANCHES;
    const calculateOmnichannelScore = typeof branchMetrics.calculateOmnichannelScore === 'function' ? branchMetrics.calculateOmnichannelScore : fallbackScore;
    const branches = await safeCall('Winkellijst', warnings, FALLBACK_BRANCHES, async () => listBranches());
    const storeToBranchId = new Map((branches || []).map((branch) => [storeKey(branch.store), branchKey(branch.branchId)]));

    const [logs, customerResult, labels, cancellations, negativeStockReport] = await Promise.all([
      safeCall('Vouchers', warnings, [], async () => typeof voucherStore.getVoucherLogs === 'function' ? voucherStore.getVoucherLogs() : []),
      safeCall('Klanten', warnings, { customers: [] }, async () => typeof customersClient.getCustomers === 'function'
        ? customersClient.getCustomers({ createdFrom: `${dateFrom}T00:00:00`, createdUntil: `${dateTo}T23:59:59` })
        : { customers: [] }),
      safeCall('Sendcloud labels', warnings, [], async () => typeof labelStore.getLabels === 'function' ? labelStore.getLabels() : []),
      safeCall('Annuleringen', warnings, [], async () => typeof cancellationStore.getOrderCancellations === 'function' ? cancellationStore.getOrderCancellations() : []),
      safeCall('Min-voorraad', warnings, { rows: [], byStore: [], totals: {}, updatedAt: '' }, async () => typeof stockStore.getStockNegativeReport === 'function' ? stockStore.getStockNegativeReport() : { rows: [], byStore: [], totals: {}, updatedAt: '' })
    ]);

    const customers = Array.isArray(customerResult?.customers) ? customerResult.customers : [];
    const cancellationRows = cancellationLines(cancellations, cancellationStore.cancellationLineRows);

    const maps = {
      customers: customersByBranch(customers, dateFrom, dateTo),
      vouchers: vouchersByBranch(logs, dateFrom, dateTo, storeToBranchId),
      labels: labelsByStore(labels, dateFrom, dateTo),
      ops: opsByStore(cancellationRows, dateFrom, dateTo),
      stock: negativeStockByStore(negativeStockReport)
    };

    const rows = (branches || [])
      .map((branch) => buildRow(branch, maps, customers.length > 0, calculateOmnichannelScore))
      .sort((a, b) => b.score - a.score || a.store.localeCompare(b.store, 'nl'));

    const stockTotals = rows.reduce((acc, row) => {
      acc.negativeStockLines += Number(row.components.negativeStockLines || 0);
      acc.negativeStockPieces += Number(row.components.negativeStockPieces || 0);
      acc.negativeStockValue += Number(row.components.negativeStockValue || 0);
      acc.unavailableLines += Number(row.components.unavailableLines || 0);
      acc.unavailableAmount += Number(row.components.unavailableAmount || 0);
      acc.cancelledLines += Number(row.components.cancelledLines || 0);
      acc.cancelledAmount += Number(row.components.cancelledAmount || 0);
      acc.lostRevenueAmount += Number(row.components.lostRevenueAmount || 0);
      return acc;
    }, {
      negativeStockLines: 0,
      negativeStockPieces: 0,
      negativeStockValue: 0,
      unavailableLines: 0,
      unavailableAmount: 0,
      cancelledLines: 0,
      cancelledAmount: 0,
      lostRevenueAmount: 0
    });

    const payload = {
      success: true,
      degraded: warnings.length > 0,
      warnings,
      dateFrom,
      dateTo,
      mode: 'resilient-scoreboard-no-hard-fail',
      sourceCustomerCount: customers.length,
      formula: {
        totalScore: '35% basis + 30% voorraadkwaliteit + 10% voucherkwaliteit + 10% SRS operationeel + 15% service/labels',
        stockQuality: '100 - nietLeverbaar*15 - geannuleerd*10 - failed*12 - minVoorraadRegels*4 - negatieveStuks*2',
        voucherQuality: 'voucherGebruik% - voucherFouten*10',
        webordersLateNote: 'Weborders te laat tellen niet mee in voorraadkwaliteit.'
      },
      dataQuality: {
        sourceCustomerCount: customers.length,
        hasCustomerData: customers.length > 0,
        cancellationLineCount: cancellationRows.length,
        labelCount: Array.isArray(labels) ? labels.length : 0,
        negativeStockUpdatedAt: negativeStockReport?.updatedAt || '',
        negativeStockLineCount: Number(negativeStockReport?.totals?.negativeLineCount || 0),
        warnings
      },
      stockTotals,
      rows
    };

    cache.set(cacheKey, { createdAt: Date.now(), payload });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return res.status(200).json({
      ...payload,
      cache: { hit: false, ttlMs: CACHE_TTL }
    });
  } catch (error) {
    console.error('Omnichannel scoreboard fatal error:', error);

    return res.status(200).json({
      success: true,
      degraded: true,
      warnings: [...warnings, error.message || 'Onbekende scoreboard fout'],
      message: 'Omnichannel score kon niet volledig worden berekend. Fallback zonder harde 500 is gebruikt.',
      dateFrom: String(req.query.dateFrom || req.query.from || daysAgo(7)).trim(),
      dateTo: String(req.query.dateTo || req.query.to || isoDate(new Date())).trim(),
      mode: 'fatal-fallback-empty-scoreboard',
      sourceCustomerCount: 0,
      formula: {},
      dataQuality: { warnings },
      stockTotals: {},
      rows: FALLBACK_BRANCHES.map((branch) => ({
        store: branch.store,
        branchId: branch.branchId,
        score: 0,
        legacyScore: 0,
        operationalScore: 0,
        stockQualityScore: 0,
        voucherQualityScore: 0,
        dataQuality: 'fallback',
        dataQualityDetails: {},
        components: {},
        targets: {},
        scoreExplanation: 'Fallback door backend fout.',
        scoreBreakdown: {}
      })),
      cache: { hit: false, ttlMs: CACHE_TTL }
    });
  }
}
