/**
 * GET /api/admin/scoreboard/omnichannel-v2?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 *
 * Vier-pijler Omnichannel Score (0-100) — winkelvriendelijke variant.
 *
 *   1. KLANTBEKENDHEID   (30 pt)  % transacties met gekoppelde klant
 *   2. LOYALTY-ACTIVATIE (25 pt)  voucher-verzilveringsratio
 *   3. CROSS-CHANNEL     (25 pt)  afhaalorders op tijd + retour-labels
 *   4. DATA-KWALITEIT    (20 pt)  -3/-2/-1 voor niet-leverbaar/geannuleerd/min-voorraad
 *
 * Eindscore = som van de 4 pijlerscores.
 *
 * Tie-breaker bij gelijke totaalscore = hoogste klantbekendheid.
 * Minimum 50 transacties in periode om mee te dingen voor "winnaar" — anders eligible=false.
 *
 * Input filters:
 *   ?store=GENTS Delft     — alleen één winkel
 *   ?branchId=5            — alternatief filter
 *   ?minTransactions=50    — drempel aanpassen (default 50)
 *
 * Response:
 *   {
 *     success: true,
 *     dateFrom, dateTo,
 *     minTransactions,
 *     rows: [{ store, branchId, score, eligible, pillars, transactions, ... }],
 *     formula: { ... },
 *     warnings: []
 *   }
 *
 * Data komt uit dezelfde 4 admin-endpoints als v1 + pickup-orders + SRS transacties.
 */

import { listBranches } from '../../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const CACHE_TTL_MS = Math.max(60000, Number(process.env.OMNICHANNEL_V2_CACHE_MS || 300000) || 300000);
const cache = new Map();

function isoDate(date) { return date.toISOString().slice(0, 10); }
function daysAgo(days) { const d = new Date(); d.setDate(d.getDate() - days); return isoDate(d); }
function isIsoDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')); }
function clean(value) { return String(value || '').trim(); }
function cleanStatus(value) { return clean(value).toLowerCase().replace(/[_-]+/g, ' ').trim(); }

function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;
  const expected = String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function matchesPeriod(value, from, to) {
  if (!value) return false;
  const d = String(value).slice(0, 10);
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

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
      warnings.push(`${label}: HTTP ${response.status} ${data.message || data.error || ''}`.trim());
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

function normalizeStore(value) {
  const raw = clean(value);
  return raw ? raw.replace(/\s+/g, ' ') : '';
}

/* ─────────────────────────────────────────────────────────────────────────
   PIJLER 1: KLANTBEKENDHEID
   ───────────────────────────────────────────────────────────────────────── */
function scoreCustomers({ transactions = 0, transactionsWithCustomer = 0 }) {
  const rate = transactions > 0 ? (transactionsWithCustomer / transactions) * 100 : 0;
  let score = 0;
  if (rate >= 80) score = 30;
  else if (rate >= 60) score = 20;
  else if (rate >= 40) score = 10;
  else score = 0;

  return {
    score,
    max: 30,
    rate: Math.round(rate * 10) / 10,
    transactions,
    transactionsWithCustomer,
    label: 'Klantbekendheid',
    suggestion: rate >= 80
      ? 'Top — blijf vragen naar e-mail bij elke kassabon.'
      : rate >= 60
        ? 'Goed. Doel: 80% van transacties met klantkoppeling.'
        : 'Vraag actiever om e-mail aan de kassa.'
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   PIJLER 2: LOYALTY-ACTIVATIE
   ───────────────────────────────────────────────────────────────────────── */
function scoreLoyalty({ vouchersIssued = 0, vouchersUsed = 0 }) {
  const rate = vouchersIssued > 0 ? (vouchersUsed / vouchersIssued) * 100 : 0;
  let score = 0;

  /* Geen uitgereikte vouchers in periode = neutraal (geen bonus, geen straf). */
  if (vouchersIssued === 0) {
    return {
      score: 0,
      max: 25,
      rate: 0,
      vouchersIssued,
      vouchersUsed,
      label: 'Loyalty-activatie',
      suggestion: 'Geen voucher-activiteit in deze periode. Wijs klanten op spaarpunten.'
    };
  }

  if (rate >= 70) score = 25;
  else if (rate >= 50) score = 15;
  else if (rate >= 30) score = 5;
  else score = 0;

  return {
    score,
    max: 25,
    rate: Math.round(rate * 10) / 10,
    vouchersIssued,
    vouchersUsed,
    label: 'Loyalty-activatie',
    suggestion: rate >= 70
      ? 'Top — klanten verzilveren actief.'
      : rate >= 50
        ? 'Goed. Doel: 70% verzilveringsratio.'
        : 'Herinner klanten met openstaande vouchers per mail.'
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   PIJLER 3: CROSS-CHANNEL FLOW
   ───────────────────────────────────────────────────────────────────────── */
function scoreCrossChannel({ pickupOrders = 0, pickupOnTime = 0, labelsCreated = 0 }) {
  const pickupRate = pickupOrders > 0 ? (pickupOnTime / pickupOrders) * 100 : 100;
  const pickupScore = Math.min(15, Math.round((pickupRate / 100) * 15));
  const labelScore = Math.min(10, labelsCreated * 2);
  const score = pickupScore + labelScore;

  return {
    score,
    max: 25,
    pickupRate: Math.round(pickupRate * 10) / 10,
    pickupOnTime,
    pickupOrders,
    pickupScore,
    labelsCreated,
    labelScore,
    label: 'Cross-channel',
    suggestion: pickupScore < 12
      ? 'Pak afhaalorders sneller op binnen 24u.'
      : labelsCreated < 5
        ? 'Maak retour-labels rechtstreeks vanuit de winkel.'
        : 'Top — flow tussen webshop en winkel zit goed.'
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   PIJLER 4: DATA-KWALITEIT
   ───────────────────────────────────────────────────────────────────────── */
function scoreData({ unavailableLines = 0, cancelledLines = 0, negativeStockSkus = 0 }) {
  const penalty = unavailableLines * 3 + cancelledLines * 2 + negativeStockSkus * 1;
  const score = Math.max(0, 20 - penalty);

  return {
    score,
    max: 20,
    unavailableLines,
    cancelledLines,
    negativeStockSkus,
    penalty,
    label: 'Data-kwaliteit',
    suggestion: unavailableLines > 2
      ? 'Loop niet-leverbare orders na — vaak zit voorraad er nog wel.'
      : cancelledLines > 2
        ? 'Bekijk geannuleerde fulfillments en voorkom annulaties.'
        : negativeStockSkus > 0
          ? 'Loop SKUs met negatieve voorraad na in SRS.'
          : 'Top — administratie klopt.'
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   DATA-EXTRACTIE: maps per store
   ───────────────────────────────────────────────────────────────────────── */
function customersMapFromReport(data) {
  const map = new Map();
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  for (const row of rows) {
    const store = normalizeStore(row.store || row.branchName || row.name);
    if (!store) continue;
    map.set(store, {
      transactions: Number(row.totalTransactions ?? row.transactions ?? row.bonCount ?? row.bonnen ?? 0),
      transactionsWithCustomer: Number(row.transactionsWithCustomer ?? row.bonnenMetKlant ?? row.bonnenWithCustomer ?? row.withCustomer ?? 0),
      customerRegistrations: Number(row.totalCustomers ?? row.customerCount ?? row.total ?? row.newCustomers ?? row.customers ?? 0)
    });
  }
  return map;
}

function vouchersMapFromReport(rows, from, to) {
  const map = new Map();
  for (const voucher of rows || []) {
    const dateForFilter = voucher.createdAt || voucher.usedAt || voucher.validFrom || voucher.validTo;
    if (dateForFilter && !matchesPeriod(dateForFilter, from, to)) continue;
    const store = normalizeStore(voucher.usedStore || voucher.store || voucher.createdStore);
    if (!store) continue;
    const row = map.get(store) || { vouchersIssued: 0, vouchersUsed: 0 };
    row.vouchersIssued += 1;
    const status = cleanStatus(voucher.status);
    if (status.includes('gebruikt') || status.includes('used') || status.includes('afgeboekt')) {
      row.vouchersUsed += 1;
    }
    map.set(store, row);
  }
  return map;
}

function pickupMapFromOrders(rows, from, to) {
  const map = new Map();
  const PICKUP_DEADLINE_MS = 24 * 60 * 60 * 1000;
  for (const order of rows || []) {
    const created = order.createdAt || order.created_at || order.dateTime;
    if (created && !matchesPeriod(created, from, to)) continue;
    const store = normalizeStore(order.store || order.pickupStore || order.branchName);
    if (!store) continue;
    const row = map.get(store) || { pickupOrders: 0, pickupOnTime: 0 };
    row.pickupOrders += 1;
    const createdMs = new Date(created || 0).getTime();
    const pickedUpMs = order.pickedUpAt || order.picked_up_at ? new Date(order.pickedUpAt || order.picked_up_at).getTime() : 0;
    if (pickedUpMs && createdMs && (pickedUpMs - createdMs) <= PICKUP_DEADLINE_MS) {
      row.pickupOnTime += 1;
    } else if (!pickedUpMs && createdMs && (Date.now() - createdMs) <= PICKUP_DEADLINE_MS) {
      /* Nog niet opgehaald maar wel binnen 24u tot nu — telt als on-time (winkel doet z'n best). */
      row.pickupOnTime += 1;
    }
    map.set(store, row);
  }
  return map;
}

function labelsMapFromReport(rows, from, to) {
  const map = new Map();
  for (const label of rows || []) {
    if (!matchesPeriod(label.createdAt, from, to)) continue;
    const store = normalizeStore(label.senderStore || label.store);
    if (!store) continue;
    map.set(store, (map.get(store) || 0) + 1);
  }
  const out = new Map();
  for (const [store, count] of map) out.set(store, { labelsCreated: count });
  return out;
}

function dataMapFromCancellations(rows, from, to) {
  const map = new Map();
  for (const item of rows || []) {
    if (!matchesPeriod(item.createdAt || item.updatedAt || item.cancelledAt, from, to)) continue;
    const store = normalizeStore(item.store || 'SRS zonder filiaal');
    const status = cleanStatus(item.srsLineStatus || item.srsStatus || item.status || item.reason);
    const row = map.get(store) || { unavailableLines: 0, cancelledLines: 0, negativeStockSkus: 0 };
    if (status.includes('unavailable') || status.includes('niet leverbaar') || status.includes('not available')) {
      row.unavailableLines += 1;
    }
    if (status.includes('cancelled') || status.includes('canceled') || status.includes('geannuleerd')) {
      row.cancelledLines += 1;
    }
    map.set(store, row);
  }
  return map;
}

/* ─────────────────────────────────────────────────────────────────────────
   ROW BUILDER per branch
   ───────────────────────────────────────────────────────────────────────── */
function buildRow(branch, maps, minTransactions) {
  const c = maps.customers.get(branch.store) || { transactions: 0, transactionsWithCustomer: 0 };
  const v = maps.vouchers.get(branch.store) || { vouchersIssued: 0, vouchersUsed: 0 };
  const p = maps.pickup.get(branch.store) || { pickupOrders: 0, pickupOnTime: 0 };
  const l = maps.labels.get(branch.store) || { labelsCreated: 0 };
  const d = maps.data.get(branch.store) || { unavailableLines: 0, cancelledLines: 0, negativeStockSkus: 0 };

  const customers = scoreCustomers(c);
  const loyalty = scoreLoyalty(v);
  const crossChannel = scoreCrossChannel({ ...p, labelsCreated: l.labelsCreated });
  const data = scoreData(d);

  const score = customers.score + loyalty.score + crossChannel.score + data.score;
  const eligible = c.transactions >= minTransactions;

  /* Top 3 verbeterpunten: kies pijlers met grootste "gat" tot max */
  const gaps = [
    { key: 'customers', gap: customers.max - customers.score, suggestion: customers.suggestion, label: customers.label },
    { key: 'loyalty', gap: loyalty.max - loyalty.score, suggestion: loyalty.suggestion, label: loyalty.label },
    { key: 'crossChannel', gap: crossChannel.max - crossChannel.score, suggestion: crossChannel.suggestion, label: crossChannel.label },
    { key: 'data', gap: data.max - data.score, suggestion: data.suggestion, label: data.label }
  ].sort((a, b) => b.gap - a.gap).filter((row) => row.gap > 0).slice(0, 3);

  return {
    store: branch.store,
    branchId: branch.branchId,
    score,
    eligible,
    transactions: c.transactions,
    pillars: {
      customers,
      loyalty,
      crossChannel,
      data
    },
    topActions: gaps,
    color: score >= 80 ? 'green' : score >= 60 ? 'orange' : 'red'
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   HANDLER
   ───────────────────────────────────────────────────────────────────────── */
export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const warnings = [];

  try {
    const dateFrom = clean(req.query.dateFrom || req.query.from || daysAgo(30));
    const dateTo = clean(req.query.dateTo || req.query.to || isoDate(new Date()));
    const minTransactions = Math.max(0, Number(req.query.minTransactions || 50) || 50);
    const storeFilter = clean(req.query.store);
    const branchIdFilter = clean(req.query.branchId);

    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      return res.status(400).json({ success: false, message: 'Ongeldige datum (YYYY-MM-DD).' });
    }
    if (dateFrom > dateTo) {
      return res.status(400).json({ success: false, message: 'dateFrom mag niet na dateTo liggen.' });
    }

    const cacheKey = `${dateFrom}|${dateTo}|${minTransactions}|${storeFilter}|${branchIdFilter}`;
    const cached = cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS && !req.query.refresh) {
      return res.status(200).json({ ...cached.payload, cache: { hit: true, ttlMs: CACHE_TTL_MS } });
    }

    const root = baseUrl(req);
    const token = encodeURIComponent(String(process.env.ADMIN_TOKEN || '').trim());
    const query = `dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}&from=${encodeURIComponent(dateFrom)}&to=${encodeURIComponent(dateTo)}&adminToken=${token}`;

    const [customerReport, voucherReport, labelReport, cancellationsReport, pickupReport] = await Promise.all([
      fetchJson(`${root}/api/admin/customers/weekly-report?${query}&allBranches=true&allReceipts=true`, warnings, 'customers-report'),
      fetchJson(`${root}/api/admin/vouchers/report?${query}`, warnings, 'voucher-report'),
      fetchJson(`${root}/api/sendcloud/labels?${query}`, warnings, 'sendcloud-labels'),
      fetchJson(`${root}/api/admin/order-cancellations/report?${query}&includeLines=true`, warnings, 'order-cancellations'),
      fetchJson(`${root}/api/pickup-orders?status=all&days=60&adminToken=${token}`, warnings, 'pickup-orders')
    ]);

    const maps = {
      customers: customersMapFromReport(customerReport || {}),
      vouchers: vouchersMapFromReport(
        Array.isArray(voucherReport?.rows) ? voucherReport.rows : Array.isArray(voucherReport?.vouchers) ? voucherReport.vouchers : [],
        dateFrom, dateTo
      ),
      labels: labelsMapFromReport(
        Array.isArray(labelReport?.labels) ? labelReport.labels : Array.isArray(labelReport?.rows) ? labelReport.rows : [],
        dateFrom, dateTo
      ),
      data: dataMapFromCancellations(
        Array.isArray(cancellationsReport?.rows) ? cancellationsReport.rows : [],
        dateFrom, dateTo
      ),
      pickup: pickupMapFromOrders(
        Array.isArray(pickupReport?.orders) ? pickupReport.orders : [],
        dateFrom, dateTo
      )
    };

    let branches = listBranches();
    if (storeFilter) {
      branches = branches.filter((branch) => branch.store === storeFilter);
    } else if (branchIdFilter) {
      branches = branches.filter((branch) => String(branch.branchId) === branchIdFilter);
    }

    const rows = branches
      .map((branch) => buildRow(branch, maps, minTransactions))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        /* Tie-breaker: hoogste klantbekendheid */
        const ca = a.pillars.customers.score;
        const cb = b.pillars.customers.score;
        if (cb !== ca) return cb - ca;
        return a.store.localeCompare(b.store, 'nl');
      });

    const payload = {
      success: true,
      dateFrom,
      dateTo,
      minTransactions,
      mode: 'omnichannel-v2',
      warnings,
      formula: {
        version: 2,
        pillars: {
          customers: { weight: 30, label: 'Klantbekendheid', metric: '% transacties met gekoppelde klant' },
          loyalty: { weight: 25, label: 'Loyalty-activatie', metric: 'voucher-verzilveringsratio' },
          crossChannel: { weight: 25, label: 'Cross-channel', metric: 'afhaal binnen 24u + retour-labels' },
          data: { weight: 20, label: 'Data-kwaliteit', metric: '-3/-2/-1 per nietLeverbaar/geannuleerd/minVoorraad' }
        },
        tieBreaker: 'hoogste klantbekendheid wint',
        minTransactions,
        colors: { green: '>= 80', orange: '>= 60', red: '< 60' }
      },
      totals: {
        branches: rows.length,
        eligible: rows.filter((row) => row.eligible).length,
        averageScore: rows.length ? Math.round(rows.reduce((sum, row) => sum + row.score, 0) / rows.length) : 0
      },
      rows
    };

    cache.set(cacheKey, { createdAt: Date.now(), payload });
    if (cache.size > 100) cache.delete(cache.keys().next().value);

    return res.status(200).json({ ...payload, cache: { hit: false, ttlMs: CACHE_TTL_MS } });
  } catch (error) {
    console.error('[omnichannel-v2]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Onverwachte fout in omnichannel-v2.',
      warnings
    });
  }
}
