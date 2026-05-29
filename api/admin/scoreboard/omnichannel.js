const CACHE_TTL = Math.max(1000, Number(process.env.OMNICHANNEL_SCOREBOARD_CACHE_MS || 120000) || 120000);
const cache = new Map();

const DEFAULT_BRANCHES = [
  ['1','GENTS Almere'], ['2','GENTS Amersfoort'], ['3','GENTS Amsterdam'], ['4','GENTS Arnhem'],
  ['5','GENTS Breda'], ['6','GENTS Delft'], ['7','GENTS Den Bosch'], ['8','GENTS Enschede'],
  ['9','GENTS Groningen'], ['10','GENTS Hilversum'], ['11','GENTS Leiden'], ['12','GENTS Maastricht'],
  ['13','GENTS Nijmegen'], ['14','GENTS Rotterdam'], ['15','GENTS Tilburg'], ['16','GENTS Utrecht'],
  ['17','GENTS Zoetermeer'], ['18','GENTS Zwolle']
].map(([branchId, store]) => ({ branchId, store }));

function setCors(res, methods = ['GET', 'OPTIONS']) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;
  const expected = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
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
function moneyNumber(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }

function baseUrl(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || process.env.VERCEL_URL || 'storegents.vercel.app';
  const protocol = req.headers['x-forwarded-proto'] || 'https';
  return `${protocol}://${host}`.replace(/\/$/, '');
}

async function fetchJson(url, warnings, label, timeoutMs = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch (_error) { data = { message: text }; }
    if (!response.ok || data.success === false) {
      warnings.push(`${label}: HTTP ${response.status} ${data.message || data.error || text || ''}`.trim());
      return null;
    }
    return data;
  } catch (error) {
    warnings.push(`${label}: ${error.name === 'AbortError' ? 'timeout' : (error.message || String(error))}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function scoreBase({ customerRegistrations = 0, loyaltyOptIn = 0, voucherUsed = 0, labelCreated = 0 }) {
  const targets = { customerTarget: 10, loyaltyTarget: 8, voucherTarget: 60, labelTarget: 5 };
  const customerScore = Math.min(100, pct(customerRegistrations, targets.customerTarget));
  const loyaltyScore = Math.min(100, pct(loyaltyOptIn, targets.loyaltyTarget));
  const voucherScore = Math.min(100, pct(voucherUsed, targets.voucherTarget));
  const labelScore = Math.min(100, pct(labelCreated, targets.labelTarget));
  const score = Math.round(customerScore * 0.35 + loyaltyScore * 0.25 + voucherScore * 0.25 + labelScore * 0.15);
  return { score, components: { customerRegistrations, loyaltyOptIn, customerScore, loyaltyScore, voucherScore, labelScore }, targets };
}

function stockScore({ unavailableLines = 0, cancelledLines = 0, failedLines = 0, negativeStockLines = 0, negativeStockPieces = 0 }) {
  const penalty = unavailableLines * 15 + cancelledLines * 10 + failedLines * 12 + negativeStockLines * 4 + negativeStockPieces * 2;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}
function opsScore({ unavailableLines = 0, cancelledLines = 0, failedLines = 0 }) {
  return Math.max(0, Math.min(100, 100 - unavailableLines * 15 - cancelledLines * 8 - failedLines * 12));
}
function voucherQuality(v) {
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

function normalizeStore(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^gents\s+/i.test(raw)) return raw.replace(/\s+/g, ' ');
  return raw.replace(/\s+/g, ' ');
}

function customersMapFromReport(data) {
  const map = new Map();
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  for (const row of rows) {
    const store = normalizeStore(row.store || row.branchName || row.name);
    if (!store) continue;
    const total = Number(row.totalCustomers ?? row.customerCount ?? row.total ?? row.newCustomers ?? row.customers ?? 0);
    const withEmail = Number(row.withEmail ?? row.emailCount ?? row.customersWithEmail ?? 0);
    map.set(store, {
      customerRegistrations: total,
      loyaltyOptIn: Number(row.loyaltyOptIn ?? row.loyalty ?? withEmail ?? 0),
      withEmail,
      withoutEmail: Number(row.withoutEmail ?? Math.max(0, total - withEmail))
    });
  }
  return map;
}

function labelsMap(labels, from, to) {
  const map = new Map();
  for (const label of labels || []) {
    if (!matchesPeriod(label.createdAt, from, to)) continue;
    const store = normalizeStore(label.senderStore || label.store);
    if (!store) continue;
    const row = map.get(store) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
    row.labelCreated += 1;
    if (label.trackingNumber || label.trackingUrl) row.labelWithTracking += 1;
    const status = cleanStatus(label.shipmentState || label.status);
    if (status.includes('ready') || status.includes('open') || status.includes('delivered') || status.includes('transit') || status.includes('onderweg') || status.includes('verzonden')) row.labelDeliveredOrTransit += 1;
    map.set(store, row);
  }
  return map;
}

function vouchersMap(rows, from, to) {
  const map = new Map();
  for (const voucher of rows || []) {
    if (!matchesPeriod(voucher.createdAt || voucher.usedAt || voucher.validTo, from, to)) continue;
    const store = normalizeStore(voucher.usedStore || voucher.store || voucher.createdStore);
    if (!store) continue;
    const row = map.get(store) || { voucherIssued: 0, voucherUsed: 0, voucherOpen: 0, voucherFailed: 0 };
    row.voucherIssued += 1;
    const status = cleanStatus(voucher.status);
    if (status.includes('gebruikt') || status.includes('used') || status.includes('afgeboekt')) row.voucherUsed += 1;
    else if (status.includes('mislukt') || status.includes('failed') || voucher.error) row.voucherFailed += 1;
    else row.voucherOpen += 1;
    map.set(store, row);
  }
  return map;
}

function opsMap(rows, from, to) {
  const map = new Map();
  for (const item of rows || []) {
    if (!matchesPeriod(item.createdAt || item.updatedAt || item.cancelledAt, from, to)) continue;
    const store = normalizeStore(item.store || 'SRS zonder filiaal');
    const status = cleanStatus(item.srsLineStatus || item.srsStatus || item.status || item.reason || item.srsSourceStatus);
    const row = map.get(store) || { unavailableLines: 0, cancelledLines: 0, failedLines: 0, totalProblemLines: 0, lostRevenueAmount: 0, unavailableAmount: 0, cancelledAmount: 0 };
    const amount = moneyNumber(item.amount);
    if (status.includes('unavailable') || status.includes('niet leverbaar') || status.includes('not available')) { row.unavailableLines += 1; row.unavailableAmount += amount; }
    if (status.includes('cancelled') || status.includes('canceled') || status.includes('geannuleerd')) { row.cancelledLines += 1; row.cancelledAmount += amount; }
    if (status.includes('failed') || cleanStatus(item.error).includes('mislukt')) row.failedLines += 1;
    row.totalProblemLines += 1;
    row.lostRevenueAmount += amount;
    map.set(store, row);
  }
  return map;
}

function buildRow(branch, maps, hasAnyCustomerData) {
  const c = maps.customers.get(branch.store) || { customerRegistrations: 0, loyaltyOptIn: 0 };
  const v = maps.vouchers.get(branch.store) || { voucherIssued: 0, voucherUsed: 0, voucherOpen: 0, voucherFailed: 0 };
  const l = maps.labels.get(branch.store) || { labelCreated: 0, labelWithTracking: 0, labelDeliveredOrTransit: 0 };
  const o = maps.ops.get(branch.store) || { unavailableLines: 0, cancelledLines: 0, failedLines: 0, totalProblemLines: 0, lostRevenueAmount: 0, unavailableAmount: 0, cancelledAmount: 0 };
  const s = maps.stock.get(branch.store) || { negativeStockLines: 0, negativeStockArticles: 0, negativeStockPieces: 0, negativeStockValue: 0, negativeStockUpdatedAt: '' };

  const base = scoreBase({ ...c, voucherUsed: v.voucherUsed, labelCreated: l.labelCreated });
  const operationalScore = opsScore(o);
  const stockQualityScore = stockScore({ ...o, ...s });
  const voucherQualityScore = voucherQuality(v);
  const score = Math.round(base.score * 0.35 + stockQualityScore * 0.30 + voucherQualityScore * 0.10 + operationalScore * 0.10 + base.components.labelScore * 0.15);
  const dataQualityDetails = {
    hasCustomerData: hasAnyCustomerData,
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
      `Service ${base.components.labelScore || 0}`,
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
  setCors(res, ['GET', 'OPTIONS']);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const warnings = [];
  try {
    const dateFrom = String(req.query.dateFrom || req.query.from || daysAgo(7)).trim();
    const dateTo = String(req.query.dateTo || req.query.to || isoDate(new Date())).trim();

    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) return res.status(400).json({ success: false, message: 'Ongeldige datumnotatie. Gebruik YYYY-MM-DD.' });
    if (dateFrom > dateTo) return res.status(400).json({ success: false, message: 'Ongeldige periode: dateFrom mag niet na dateTo liggen.' });

    const cacheKey = `${dateFrom}|${dateTo}|no-import-http-scoreboard|${req.query.refresh ? Date.now() : ''}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL) return res.status(200).json({ ...cached.payload, cache: { hit: true, ttlMs: CACHE_TTL } });

    const root = baseUrl(req);
    const token = encodeURIComponent(String(process.env.ADMIN_TOKEN || '').trim());
    const query = `dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}&adminToken=${token}&admin_token=${token}`;

    const [customerReport, labelReport, voucherReport, cancellationsReport] = await Promise.all([
      fetchJson(`${root}/api/admin/customers/weekly-report?${query}&allBranches=true&allReceipts=true`, warnings, 'customers-weekly-report'),
      fetchJson(`${root}/api/sendcloud/labels?${query}`, warnings, 'sendcloud-labels'),
      fetchJson(`${root}/api/admin/vouchers/report?${query}`, warnings, 'voucher-report'),
      fetchJson(`${root}/api/admin/order-cancellations/report?${query}&includeLines=true`, warnings, 'order-cancellations')
    ]);

    const customerMap = customersMapFromReport(customerReport || {});
    const labelRows = Array.isArray(labelReport?.labels) ? labelReport.labels : Array.isArray(labelReport?.rows) ? labelReport.rows : [];
    const voucherRows = Array.isArray(voucherReport?.rows) ? voucherReport.rows : Array.isArray(voucherReport?.vouchers) ? voucherReport.vouchers : [];
    const cancellationRows = Array.isArray(cancellationsReport?.rows) ? cancellationsReport.rows : [];

    const maps = {
      customers: customerMap,
      labels: labelsMap(labelRows, dateFrom, dateTo),
      vouchers: vouchersMap(voucherRows, dateFrom, dateTo),
      ops: opsMap(cancellationRows, dateFrom, dateTo),
      stock: new Map()
    };

    const rows = DEFAULT_BRANCHES
      .map((branch) => buildRow(branch, maps, customerMap.size > 0))
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
      degraded: warnings.length > 0,
      warnings,
      dateFrom,
      dateTo,
      mode: 'no-import-http-resilient-scoreboard',
      sourceCustomerCount: Array.isArray(customerReport?.rows) ? customerReport.rows.reduce((sum, row) => sum + Number(row.totalCustomers ?? row.customerCount ?? row.total ?? row.newCustomers ?? 0), 0) : 0,
      formula: {
        totalScore: '35% basis + 30% voorraadkwaliteit + 10% voucherkwaliteit + 10% SRS operationeel + 15% service/labels',
        stockQuality: '100 - nietLeverbaar*15 - geannuleerd*10 - failed*12 - minVoorraadRegels*4 - negatieveStuks*2',
        voucherQuality: 'voucherGebruik% - voucherFouten*10',
        webordersLateNote: 'Weborders te laat tellen niet mee in voorraadkwaliteit.'
      },
      dataQuality: {
        sourceCustomerCount: Array.isArray(customerReport?.rows) ? customerReport.rows.length : 0,
        hasCustomerData: customerMap.size > 0,
        cancellationLineCount: cancellationRows.length,
        labelCount: labelRows.length,
        negativeStockUpdatedAt: '',
        negativeStockLineCount: 0,
        warnings
      },
      stockTotals,
      rows
    };

    cache.set(cacheKey, { createdAt: Date.now(), payload });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return res.status(200).json({ ...payload, cache: { hit: false, ttlMs: CACHE_TTL } });
  } catch (error) {
    warnings.push(`fatal: ${error.message || String(error)}`);
    const rows = DEFAULT_BRANCHES.map((branch) => buildRow(branch, { customers: new Map(), labels: new Map(), vouchers: new Map(), ops: new Map(), stock: new Map() }, false));
    return res.status(200).json({
      success: true,
      degraded: true,
      warnings,
      dateFrom: String(req.query.dateFrom || req.query.from || daysAgo(7)),
      dateTo: String(req.query.dateTo || req.query.to || isoDate(new Date())),
      mode: 'no-import-fatal-fallback-scoreboard',
      sourceCustomerCount: 0,
      formula: { totalScore: 'fallback', stockQuality: 'fallback', voucherQuality: 'fallback', webordersLateNote: 'fallback' },
      dataQuality: { sourceCustomerCount: 0, hasCustomerData: false, cancellationLineCount: 0, labelCount: 0, negativeStockUpdatedAt: '', negativeStockLineCount: 0, warnings },
      stockTotals: { negativeStockLines: 0, negativeStockPieces: 0, negativeStockValue: 0, unavailableLines: 0, unavailableAmount: 0, cancelledLines: 0, cancelledAmount: 0, lostRevenueAmount: 0 },
      rows
    });
  }
}
