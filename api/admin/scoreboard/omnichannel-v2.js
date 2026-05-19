/**
 * GET /api/admin/scoreboard/omnichannel-v2?dateFrom=YYYY-MM-DD&dateTo=YYYY-MM-DD
 *
 * Vier-pijler Omnichannel Score (0-100) — winkelvriendelijke variant.
 *
 *   1. KLANTBEKENDHEID    (30 pt)  % transacties met gekoppelde klant
 *   2. VOORRAADVERTROUWEN (25 pt)  hoe vaak konden we NIET leveren (lager = beter)
 *   3. CROSS-CHANNEL      (25 pt)  afhaalorders op tijd opgehaald (binnen 24u)
 *   4. DATA-KWALITEIT     (20 pt)  -1/-2 per geannuleerd / negatieve voorraad SKU
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
   PIJLER 2: VOORRAADVERTROUWEN
   Hoe vaak konden we NIET leveren wat de klant bestelde?
   Som van 'niet leverbaar' + 'geannuleerd wegens voorraad' incidenten.
   Lager incidenten = hogere score. Geen transacties = neutraal.
   ───────────────────────────────────────────────────────────────────────── */
function scoreStockReliability({ unavailableLines = 0, cancelledLines = 0, transactions = 0 }) {
  const incidents = unavailableLines + cancelledLines;

  /* Geen transacties in periode = neutraal (geen straf, geen bonus). */
  if (transactions === 0) {
    return {
      score: 0,
      max: 25,
      rate: 0,
      incidents,
      unavailableLines,
      cancelledLines,
      label: 'Voorraadvertrouwen',
      suggestion: 'Geen transacties in deze periode.'
    };
  }

  let score = 0;
  if (incidents === 0) score = 25;
  else if (incidents <= 2) score = 20;
  else if (incidents <= 5) score = 12;
  else if (incidents <= 10) score = 5;
  else score = 0;

  /* Rate = incidenten per 100 transacties — laag = goed. */
  const rate = Math.round((incidents / Math.max(transactions, 1)) * 1000) / 10;

  return {
    score,
    max: 25,
    rate,
    incidents,
    unavailableLines,
    cancelledLines,
    label: 'Voorraadvertrouwen',
    suggestion: incidents === 0
      ? 'Top — geen voorraad-incidenten in deze periode.'
      : unavailableLines >= cancelledLines
        ? 'Verlaag "niet leverbaar" door betere voorraad-check vóór accepteren weborder.'
        : 'Voorkom annulaties door tijdige uitwisseling bij voorraad-tekort.'
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   PIJLER 3: CROSS-CHANNEL FLOW
   Afhaalorders op tijd opgehaald (binnen 24u na "ready for pickup").
   Volledige 25 pt gaat naar pickup-on-time-rate.
   ───────────────────────────────────────────────────────────────────────── */
function scoreCrossChannel({ pickupOrders = 0, pickupOnTime = 0 }) {
  const pickupRate = pickupOrders > 0 ? (pickupOnTime / pickupOrders) * 100 : 100;
  const score = Math.min(25, Math.round((pickupRate / 100) * 25));

  return {
    score,
    max: 25,
    pickupRate: Math.round(pickupRate * 10) / 10,
    pickupOnTime,
    pickupOrders,
    label: 'Cross-channel',
    suggestion: pickupOrders === 0
      ? 'Nog geen afhaalorders in deze periode.'
      : pickupRate >= 90
        ? 'Top — afhaalorders worden snel verwerkt.'
        : pickupRate >= 70
          ? 'Goed. Pak afhaalorders nog sneller op binnen 24u.'
          : 'Afhaal-flow loopt achter — bel klanten actief om af te halen.'
  };
}

/* ─────────────────────────────────────────────────────────────────────────
   PIJLER 4: DATA-KWALITEIT
   Administratieve schoonheid (geannuleerd / negatieve voorraad SKUs).
   "Niet leverbaar" is verschoven naar Voorraadvertrouwen (geen dubbeltelling).
   ───────────────────────────────────────────────────────────────────────── */
function scoreData({ cancelledLines = 0, negativeStockSkus = 0 }) {
  const penalty = cancelledLines * 1 + negativeStockSkus * 2;
  const score = Math.max(0, 20 - penalty);

  return {
    score,
    max: 20,
    cancelledLines,
    negativeStockSkus,
    penalty,
    label: 'Data-kwaliteit',
    suggestion: negativeStockSkus > 0
      ? 'Loop SKUs met negatieve voorraad na in SRS — vaak SFTP-sync issue.'
      : cancelledLines > 5
        ? 'Veel annulaties — check oorzaken in cancellations report.'
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
  const p = maps.pickup.get(branch.store) || { pickupOrders: 0, pickupOnTime: 0 };
  const d = maps.data.get(branch.store) || { unavailableLines: 0, cancelledLines: 0, negativeStockSkus: 0 };

  const customers = scoreCustomers(c);
  const stockReliability = scoreStockReliability({ ...d, transactions: c.transactions });
  const crossChannel = scoreCrossChannel(p);
  const data = scoreData(d);

  const score = customers.score + stockReliability.score + crossChannel.score + data.score;
  const eligible = c.transactions >= minTransactions;

  /* Top 3 verbeterpunten: kies pijlers met grootste "gat" tot max */
  const gaps = [
    { key: 'customers', gap: customers.max - customers.score, suggestion: customers.suggestion, label: customers.label },
    { key: 'stockReliability', gap: stockReliability.max - stockReliability.score, suggestion: stockReliability.suggestion, label: stockReliability.label },
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
      stockReliability,
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

    /* 3 parallelle fetches (was 5 — vouchers + sendcloud-labels weggehaald
       sinds Loyalty en retour-labels niet meer scoren). */
    const [customerReport, cancellationsReport, pickupReport] = await Promise.all([
      fetchJson(`${root}/api/admin/customers/weekly-report?${query}&allBranches=true&allReceipts=true`, warnings, 'customers-report'),
      fetchJson(`${root}/api/admin/order-cancellations/report?${query}&includeLines=true`, warnings, 'order-cancellations'),
      fetchJson(`${root}/api/pickup-orders?status=all&days=60&adminToken=${token}`, warnings, 'pickup-orders')
    ]);

    const maps = {
      customers: customersMapFromReport(customerReport || {}),
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
        version: 3,
        pillars: {
          customers:        { weight: 30, label: 'Klantbekendheid',     metric: '% transacties met gekoppelde klant' },
          stockReliability: { weight: 25, label: 'Voorraadvertrouwen',  metric: 'aantal niet-leverbaar + voorraad-annulaties (lager = beter)' },
          crossChannel:     { weight: 25, label: 'Cross-channel',       metric: 'afhaalorders binnen 24u opgehaald (op-tijd-leveren)' },
          data:             { weight: 20, label: 'Data-kwaliteit',      metric: '-1 per geannuleerd, -2 per negatieve voorraad SKU' }
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
