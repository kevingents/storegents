import { getCustomers } from '../../../lib/srs-customers-client.js';
import { getVoucherLogs } from '../../../lib/voucher-log-store.js';
import { listBranches, calculateOmnichannelScore } from '../../../lib/branch-metrics.js';
import { getOrderCancellations, cancellationLineRows } from '../../../lib/order-cancellation-store.js';
import { getLabels } from '../../../lib/sendcloud-labels-store.js';
import { getStockNegativeReport } from '../../../lib/stock-negative-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const CACHE_TTL = Math.max(1000, Number(process.env.OMNICHANNEL_SCOREBOARD_CACHE_MS || 120000) || 120000);
const cache = new Map();

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken || String(req.query.public || '') === 'true';
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function daysAgo(days) { const d = new Date(); d.setDate(d.getDate() - days); return isoDate(d); }
function isIsoDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function cleanStatus(value) { return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim(); }
function matchesPeriod(value, from, to) {
  if (!value) return false;
  const d = String(value).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}
function pct(part, total) {
  const p = Number(part || 0);
  const t = Number(total || 0);
  return t ? Math.round((p / t) * 100) : 0;
}
function usedVoucher(status) {
  return ['afgeboekt_in_srs', 'gebruikt_in_winkel_shopify_gedeactiveerd', 'gebruikt_in_winkel_geen_shopify', 'gebruikt_in_shopify'].includes(String(status || ''));
}

function customersByBranch(customers, from, to) {
  const map = new Map();
  for (const c of customers || []) {
    if (!matchesPeriod(c.createdAt, from, to)) continue;
    const id = String(c.registeredInBranchId || '').trim();
    if (!id) continue;
    const row = map.get(id) || { customerRegistrations: 0, loyaltyOptIn: 0 };
    row.customerRegistrations += 1;
    if (String(c.receivesLoyaltyPoints).toLowerCase() === 'true') row.loyaltyOptIn += 1;
    map.set(id, row);
  }
  return map;
}

function vouchersByBranch(logs, from, to, storeToBranchId) {
  const map = new Map();
  for (const log of logs || []) {
    if (!matchesPeriod(log.createdAt, from, to)) continue;
    const id = String(log.srsRedeemBranchId || storeToBranchId.get(String(log.store || '').trim()) || '').trim();
    if (!id) continue;
    const row = map.get(id) || { voucherIssued: 0, voucherUsed: 0, voucherOpen: 0, voucherFailed: 0 };
    row.voucherIssued += 1;
    if (usedVoucher(log.status)) row.voucherUsed += 1;
    else if (String(log.status || '').includes('mislukt') || String(log.status || '').includes('failed')) row.voucherFailed += 1;
    else row.voucherOpen += 1;
    map.set(id, row);
  }
  return map;
}

function labelsByStore(labels, from, to) {
  const map = new Map();
  for (const l of labels || []) {
    if (!matchesPeriod(l.createdAt, from, to)) continue;
    const store = String(l.senderStore || l.store || '').trim();
    if (!store) continue;
    const row = map.get(store) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
    row.labelCreated += 1;
    if (l.trackingNumber || l.trackingUrl) row.labelWithTracking += 1;
    const s = cleanStatus(l.shipmentState || l.status);
    if (s.includes('verzonden') || s.includes('delivered') || s.includes('transit') || s.includes('onderweg')) row.labelDeliveredOrTransit += 1;
    map.set(store, row);
  }
  return map;
}

function opsByStore(rows, from, to) {
  const map = new Map();
  for (const row of rows || []) {
    if (!matchesPeriod(row.createdAt || row.updatedAt, from, to)) continue;
    const store = String(row.store || 'SRS zonder filiaal').trim();
    const status = cleanStatus(row.srsLineStatus || row.srsStatus || row.status || row.reason || row.srsSourceStatus);
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
    if (status.includes('failed') || cleanStatus(row.error).includes('mislukt')) agg.failedLines += 1;
    agg.totalProblemLines += 1;
    agg.lostRevenueAmount += amount;
    map.set(store, agg);
  }
  return map;
}

function negativeStockByStore(report) {
  const map = new Map();
  for (const row of report.byStore || []) {
    const store = String(row.store || '').trim();
    if (!store) continue;
    map.set(store, {
      negativeStockLines: Number(row.negativeLineCount || 0),
      negativeStockArticles: Number(row.negativeArticleCount || 0),
      negativeStockPieces: Math.abs(Number(row.negativePieces || 0)),
      negativeStockValue: Number(row.negativeValue || 0),
      negativeStockUpdatedAt: row.updatedAt || report.updatedAt || ''
    });
  }
  return map;
}

function stockScore({ unavailableLines = 0, cancelledLines = 0, failedLines = 0, negativeStockLines = 0, negativeStockPieces = 0, overdueExchangeCount = 0 }) {
  const penalty = unavailableLines * 15 + cancelledLines * 10 + failedLines * 12 + negativeStockLines * 4 + negativeStockPieces * 2 + overdueExchangeCount * 5;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

function opsScore({ unavailableLines = 0, cancelledLines = 0, failedLines = 0 }) {
  return Math.max(0, Math.min(100, 100 - unavailableLines * 15 - cancelledLines * 8 - failedLines * 12));
}

function voucherScore(v) {
  if (!Number(v.voucherIssued || 0)) return 100;
  return Math.max(0, Math.min(100, pct(v.voucherUsed, v.voucherIssued) - Number(v.voucherFailed || 0) * 10));
}

function dataQualityText(d) {
  const parts = [];
  if (d.hasCustomerData) parts.push('klanten');
  if (d.hasVoucherData) parts.push('vouchers');
  if (d.hasLabelData) parts.push('labels');
  if (d.hasSrsOperationalData) parts.push('SRS');
  if (d.hasNegativeStockData) parts.push('min-voorraad');
  return parts.length ? parts.join(' + ') : 'geen data';
}

function buildRow(branch, customerMap, voucherMap, labelMap, opsMap, stockMap, hasCustomerData) {
  const branchKey = String(branch.branchId || '').trim();
  const c = customerMap.get(branchKey) || { customerRegistrations: 0, loyaltyOptIn: 0 };
  const v = voucherMap.get(branchKey) || { voucherIssued: 0, voucherUsed: 0, voucherOpen: 0, voucherFailed: 0 };
  const l = labelMap.get(branch.store) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
  const o = opsMap.get(branch.store) || { unavailableLines: 0, cancelledLines: 0, failedLines: 0, totalProblemLines: 0, lostRevenueAmount: 0, unavailableAmount: 0, cancelledAmount: 0 };
  const s = stockMap.get(branch.store) || { negativeStockLines: 0, negativeStockArticles: 0, negativeStockPieces: 0, negativeStockValue: 0, negativeStockUpdatedAt: '' };

  const base = calculateOmnichannelScore({
    customerRegistrations: c.customerRegistrations,
    loyaltyOptIn: c.loyaltyOptIn,
    voucherIssued: v.voucherIssued,
    voucherUsed: v.voucherUsed,
    labelCreated: l.labelCreated
  });

  const operationalScore = opsScore(o);
  const stockQualityScore = stockScore({ ...o, ...s, overdueExchangeCount: 0 });
  const voucherQualityScore = voucherScore(v);
  const score = Math.round(base.score * 0.35 + stockQualityScore * 0.30 + voucherQualityScore * 0.10 + operationalScore * 0.10 + base.components.labelScore * 0.15);

  const dataQualityDetails = {
    hasCustomerData,
    hasBranchCustomers: c.customerRegistrations > 0,
    hasVoucherData: v.voucherIssued > 0,
    hasLabelData: l.labelCreated > 0,
    hasSrsOperationalData: o.totalProblemLines > 0,
    hasNegativeStockData: s.negativeStockLines > 0
  };

  const components = {
    ...base.components,
    labelCreated: l.labelCreated,
    labelWithTracking: l.labelWithTracking,
    labelDeliveredOrTransit: l.labelDeliveredOrTransit,
    voucherIssued: v.voucherIssued,
    voucherUsed: v.voucherUsed,
    voucherOpen: v.voucherOpen,
    voucherFailed: v.voucherFailed,
    voucherUsageRate: pct(v.voucherUsed, v.voucherIssued),
    unavailableLines: o.unavailableLines,
    unavailableAmount: o.unavailableAmount,
    cancelledLines: o.cancelledLines,
    cancelledAmount: o.cancelledAmount,
    failedLines: o.failedLines,
    totalProblemLines: o.totalProblemLines,
    lostRevenueAmount: o.lostRevenueAmount,
    negativeStockLines: s.negativeStockLines,
    negativeStockArticles: s.negativeStockArticles,
    negativeStockPieces: s.negativeStockPieces,
    negativeStockValue: s.negativeStockValue,
    negativeStockUpdatedAt: s.negativeStockUpdatedAt,
    overdueExchangeCount: 0,
    operationalScore,
    stockQualityScore,
    voucherQualityScore
  };

  return {
    store: branch.store,
    branchId: branch.branchId,
    dataQuality: dataQualityText(dataQualityDetails),
    dataQualityDetails,
    score,
    legacyScore: base.score,
    operationalScore,
    stockQualityScore,
    voucherQualityScore,
    components,
    targets: base.targets,
    scoreExplanation: [
      `Basis ${base.score}`,
      `Voorraad ${stockQualityScore}`,
      `Vouchers ${voucherQualityScore}`,
      `SRS ${operationalScore}`,
      `Service ${base.components.labelScore ?? 0}`,
      o.unavailableLines ? `${o.unavailableLines} niet leverbaar` : '',
      o.cancelledLines ? `${o.cancelledLines} geannuleerd` : '',
      s.negativeStockLines ? `${s.negativeStockLines} min-voorraad` : ''
    ].filter(Boolean).join(' · '),
    scoreBreakdown: {
      base: base.score,
      stockQuality: stockQualityScore,
      voucherQuality: voucherQualityScore,
      srsOperationalQuality: operationalScore,
      serviceActivity: base.components.labelScore,
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

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const dateFrom = String(req.query.dateFrom || req.query.from || daysAgo(7)).trim();
    const dateTo = String(req.query.dateTo || req.query.to || isoDate(new Date())).trim();

    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) return res.status(400).json({ success: false, message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.' });
    if (dateFrom > dateTo) return res.status(400).json({ success: false, message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.' });

    const cacheKey = `${dateFrom}|${dateTo}|simple-score`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL) return res.status(200).json({ ...cached.payload, cache: { hit: true, ttlMs: CACHE_TTL } });

    const branches = listBranches();
    const storeToBranchId = new Map(branches.map((b) => [String(b.store || '').trim(), String(b.branchId || '').trim()]));

    const [logs, customerResult, labels, cancellations, negativeStockReport] = await Promise.all([
      getVoucherLogs(),
      getCustomers({ createdFrom: `${dateFrom}T00:00:00`, createdUntil: `${dateTo}T23:59:59` }),
      getLabels(),
      getOrderCancellations(),
      getStockNegativeReport().catch(() => ({ rows: [], byStore: [], totals: {}, updatedAt: '' }))
    ]);

    const customers = customerResult.customers || [];
    const cancellationRows = cancellationLineRows(cancellations || []);
    const customerMap = customersByBranch(customers, dateFrom, dateTo);
    const voucherMap = vouchersByBranch(logs, dateFrom, dateTo, storeToBranchId);
    const labelMap = labelsByStore(labels, dateFrom, dateTo);
    const opsMap = opsByStore(cancellationRows, dateFrom, dateTo);
    const stockMap = negativeStockByStore(negativeStockReport);

    const rows = branches
      .map((branch) => buildRow(branch, customerMap, voucherMap, labelMap, opsMap, stockMap, customers.length > 0))
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
    }, { negativeStockLines: 0, negativeStockPieces: 0, negativeStockValue: 0, unavailableLines: 0, unavailableAmount: 0, cancelledLines: 0, cancelledAmount: 0, lostRevenueAmount: 0 });

    const payload = {
      success: true,
      dateFrom,
      dateTo,
      mode: 'simple-scoreboard-no-object-object',
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
        labelCount: labels.length,
        negativeStockUpdatedAt: negativeStockReport.updatedAt || '',
        negativeStockLineCount: negativeStockReport.totals?.negativeLineCount || 0
      },
      stockTotals,
      rows
    };

    cache.set(cacheKey, { createdAt: Date.now(), payload });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return res.status(200).json({ ...payload, cache: { hit: false, ttlMs: CACHE_TTL } });
  } catch (error) {
    console.error('Omnichannel scoreboard error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Omnichannel score kon niet worden berekend.',
      hint: 'Controleer SRS_MESSAGE_USER, SRS_MESSAGE_PASSWORD, Customers, Vercel Blob en min-voorraad import.'
    });
  }
}
