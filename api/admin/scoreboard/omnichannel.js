import { getCustomers } from '../../../lib/srs-customers-client.js';
import { getVoucherLogs } from '../../../lib/voucher-log-store.js';
import { listBranches, calculateOmnichannelScore } from '../../../lib/branch-metrics.js';
import { getOrderCancellations, cancellationLineRows } from '../../../lib/order-cancellation-store.js';
import { getLabels } from '../../../lib/sendcloud-labels-store.js';
import { getStockNegativeReport } from '../../../lib/stock-negative-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const SCOREBOARD_CACHE_TTL_MS = Math.max(1000, Number(process.env.OMNICHANNEL_SCOREBOARD_CACHE_MS || 2 * 60 * 1000) || 2 * 60 * 1000);
const SCOREBOARD_CACHE_MAX_ENTRIES = 100;
const scoreboardCache = new Map();

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function daysAgo(days) { const date = new Date(); date.setDate(date.getDate() - days); return isoDate(date); }
function isIsoDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function toBranchKey(value) { return String(value || '').trim(); }
function toStoreKey(value) { return String(value || '').trim(); }

function matchesPeriod(dateValue, dateFrom, dateTo) {
  if (!dateValue) return false;
  const date = String(dateValue).slice(0, 10);
  if (dateFrom && date < dateFrom) return false;
  if (dateTo && date > dateTo) return false;
  return true;
}

function isVoucherUsedStatus(status) {
  return ['afgeboekt_in_srs', 'gebruikt_in_winkel_shopify_gedeactiveerd', 'gebruikt_in_winkel_geen_shopify', 'gebruikt_in_shopify'].includes(String(status || ''));
}

function cleanStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
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
    if (String(customer.receivesLoyaltyPoints).toLowerCase() === 'true') row.loyaltyOptIn += 1;
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

function aggregateLabelsByStore(labels, dateFrom, dateTo) {
  const map = new Map();
  for (const label of labels || []) {
    if (!matchesPeriod(label.createdAt, dateFrom, dateTo)) continue;
    const store = toStoreKey(label.senderStore || label.store);
    if (!store) continue;
    const row = map.get(store) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
    row.labelCreated += 1;
    if (label.trackingNumber || label.trackingUrl) row.labelWithTracking += 1;
    const state = cleanStatus(label.shipmentState || label.status);
    if (state.includes('verzonden') || state.includes('delivered') || state.includes('transit') || state.includes('onderweg')) row.labelDeliveredOrTransit += 1;
    map.set(store, row);
  }
  return map;
}

function aggregateSrsOperationalByStore(cancellationRows, dateFrom, dateTo) {
  const map = new Map();
  for (const row of cancellationRows || []) {
    if (!matchesPeriod(row.createdAt || row.updatedAt, dateFrom, dateTo)) continue;
    const store = toStoreKey(row.store);
    if (!store) continue;
    const status = cleanStatus(row.srsLineStatus || row.srsStatus || row.status || row.reason);
    const agg = map.get(store) || { unavailableLines: 0, cancelledLines: 0, failedLines: 0, totalProblemLines: 0, lostRevenueAmount: 0, unavailableAmount: 0, cancelledAmount: 0 };
    const amount = Number(row.amount || 0);
    if (status.includes('unavailable') || status.includes('niet leverbaar') || status.includes('not available')) {
      agg.unavailableLines += 1;
      agg.unavailableAmount += amount;
    }
    if (status.includes('cancelled') || status.includes('canceled') || status.includes('geannuleerd')) {
      agg.cancelledLines += 1;
      agg.cancelledAmount += amount;
    }
    if (status.includes('failed') || cleanStatus(row.status).includes('failed')) agg.failedLines += 1;
    agg.totalProblemLines += 1;
    agg.lostRevenueAmount += amount;
    map.set(store, agg);
  }
  return map;
}

function aggregateNegativeStockByStore(report) {
  const map = new Map();
  for (const row of report.byStore || []) {
    const store = toStoreKey(row.store);
    if (!store) continue;
    map.set(store, {
      negativeStockLines: Number(row.negativeLineCount || 0),
      negativeStockArticles: Number(row.negativeArticleCount || 0),
      negativeStockPieces: Number(row.negativePieces || 0),
      negativeStockValue: Number(row.negativeValue || 0),
      negativeStockUpdatedAt: row.updatedAt || report.updatedAt || ''
    });
  }
  return map;
}

function scoreStockQuality({ unavailableLines = 0, cancelledLines = 0, failedLines = 0, negativeStockLines = 0, negativeStockPieces = 0, overdueExchangeCount = 0 }) {
  // Weborders te laat horen bewust NIET bij voorraadkwaliteit.
  const penalty =
    unavailableLines * 15 +
    cancelledLines * 10 +
    failedLines * 12 +
    negativeStockLines * 4 +
    negativeStockPieces * 2 +
    overdueExchangeCount * 5;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function scoreOperational({ unavailableLines = 0, cancelledLines = 0, failedLines = 0 }) {
  const penalty = unavailableLines * 15 + cancelledLines * 8 + failedLines * 12;
  return Math.max(0, Math.min(100, 100 - penalty));
}

function blendScores({ baseScore, labelScore, operationalScore, stockQualityScore }) {
  return Math.round(baseScore * 0.45 + stockQualityScore * 0.30 + operationalScore * 0.10 + labelScore * 0.15);
}

function buildBranchScore(branch, customerAggByBranch, voucherAggByBranch, labelAggByStore, operationalAggByStore, negativeStockAggByStore, hasCustomerData) {
  const branchKey = toBranchKey(branch.branchId);
  const customerAgg = customerAggByBranch.get(branchKey) || { customerRegistrations: 0, loyaltyOptIn: 0 };
  const vouchers = voucherAggByBranch.get(branchKey) || { voucherIssued: 0, voucherUsed: 0 };
  const labels = labelAggByStore.get(branch.store) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
  const ops = operationalAggByStore.get(branch.store) || { unavailableLines: 0, cancelledLines: 0, failedLines: 0, totalProblemLines: 0, lostRevenueAmount: 0, unavailableAmount: 0, cancelledAmount: 0 };
  const stock = negativeStockAggByStore.get(branch.store) || { negativeStockLines: 0, negativeStockArticles: 0, negativeStockPieces: 0, negativeStockValue: 0, negativeStockUpdatedAt: '' };

  const base = calculateOmnichannelScore({
    customerRegistrations: customerAgg.customerRegistrations,
    loyaltyOptIn: customerAgg.loyaltyOptIn,
    voucherIssued: vouchers.voucherIssued,
    voucherUsed: vouchers.voucherUsed,
    labelCreated: labels.labelCreated
  });

  const operationalScore = scoreOperational(ops);
  const stockQualityScore = scoreStockQuality({ ...ops, ...stock, overdueExchangeCount: 0 });
  const finalScore = blendScores({ baseScore: base.score, operationalScore, stockQualityScore, labelScore: base.components.labelScore });

  return {
    store: branch.store,
    branchId: branch.branchId,
    customerError: '',
    dataQuality: {
      hasCustomerData,
      hasBranchCustomers: customerAgg.customerRegistrations > 0,
      hasVoucherData: vouchers.voucherIssued > 0,
      hasLabelData: labels.labelCreated > 0,
      hasSrsOperationalData: ops.totalProblemLines > 0,
      hasNegativeStockData: stock.negativeStockLines > 0
    },
    score: finalScore,
    legacyScore: base.score,
    operationalScore,
    stockQualityScore,
    components: {
      ...base.components,
      labelCreated: labels.labelCreated,
      labelWithTracking: labels.labelWithTracking,
      labelDeliveredOrTransit: labels.labelDeliveredOrTransit,
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
      stockQualityScore
    },
    targets: base.targets,
    scoreBreakdown: {
      customerLoyaltyVoucherBase: '45%',
      stockQuality: '30% (niet leverbaar, geannuleerd, min-voorraad, uitwisselingen +7 dagen)',
      srsOperationalQuality: '10%',
      sendcloudServiceActivity: '15%',
      note: 'Weborders te laat tellen niet mee in voorraadkwaliteit.'
    }
  };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const dateFrom = String(req.query.dateFrom || req.query.from || daysAgo(7)).trim();
    const dateTo = String(req.query.dateTo || req.query.to || isoDate(new Date())).trim();
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) return res.status(400).json({ success: false, message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.' });
    if (dateFrom > dateTo) return res.status(400).json({ success: false, message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.' });

    const cacheKey = `${dateFrom}|${dateTo}|v3-stock-quality`;
    const cached = scoreboardCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < SCOREBOARD_CACHE_TTL_MS) return res.status(200).json({ ...cached.payload, cache: { hit: true, ttlMs: SCOREBOARD_CACHE_TTL_MS } });

    const branches = listBranches();
    const storeToBranchId = new Map(branches.map((branch) => [String(branch.store || '').trim(), String(branch.branchId || '').trim()]));
    const [logs, customerResult, labels, cancellations, negativeStockReport] = await Promise.all([
      getVoucherLogs(),
      getCustomers({ createdFrom: `${dateFrom}T00:00:00`, createdUntil: `${dateTo}T23:59:59` }),
      getLabels(),
      getOrderCancellations(),
      getStockNegativeReport().catch(() => ({ rows: [], byStore: [], totals: {}, updatedAt: '' }))
    ]);

    const customers = customerResult.customers || [];
    const cancellationRows = cancellationLineRows(cancellations || []);
    const customerAggByBranch = aggregateCustomersByBranch(customers, dateFrom, dateTo);
    const voucherAggByBranch = aggregateVoucherMetricsByBranch(logs, dateFrom, dateTo, storeToBranchId);
    const labelAggByStore = aggregateLabelsByStore(labels, dateFrom, dateTo);
    const operationalAggByStore = aggregateSrsOperationalByStore(cancellationRows, dateFrom, dateTo);
    const negativeStockAggByStore = aggregateNegativeStockByStore(negativeStockReport);

    const rows = branches
      .map((branch) => buildBranchScore(branch, customerAggByBranch, voucherAggByBranch, labelAggByStore, operationalAggByStore, negativeStockAggByStore, customers.length > 0))
      .sort((a, b) => b.score - a.score);

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
    }, { negativeStockLines: 0, negativeStockPieces: 0, negativeStockValue: 0, unavailableLines: 0, unavailableAmount: 0, cancelledLines: 0, cancelledAmount: 0, lostRevenueAmount: 0 });

    const payload = {
      success: true,
      dateFrom,
      dateTo,
      mode: 'server-filter+local-aggregate+srs-operational+negative-stock-v3',
      sourceCustomerCount: customers.length,
      formula: {
        customerLoyaltyVoucherBase: '45%',
        stockQuality: '30%',
        srsOperationalQuality: '10%',
        sendcloudServiceActivity: '15%',
        stockQualityFormula: '100 - unavailable*15 - cancelled*10 - failed*12 - minVoorraadRegels*4 - negatieveStuks*2 - uitwisselingen7dagen*5',
        webordersLateNote: 'Weborders te laat tellen niet mee in voorraadkwaliteit.'
      },
      dataQuality: {
        sourceCustomerCount: customers.length,
        hasCustomerData: customers.length > 0,
        cancellationLineCount: cancellationRows.length,
        labelCount: labels.length,
        negativeStockUpdatedAt: negativeStockReport.updatedAt || '',
        negativeStockLineCount: negativeStockReport.totals?.negativeLineCount || 0
      },
      stockTotals,
      rows
    };

    scoreboardCache.set(cacheKey, { createdAt: Date.now(), payload });
    pruneScoreboardCache();
    return res.status(200).json({ ...payload, cache: { hit: false, ttlMs: SCOREBOARD_CACHE_TTL_MS } });
  } catch (error) {
    console.error('Omnichannel scoreboard error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Omnichannel score kon niet worden berekend.', hint: 'Controleer SRS_MESSAGE_USER, SRS_MESSAGE_PASSWORD, Customers, Vercel Blob en min-voorraad import.' });
  }
}
