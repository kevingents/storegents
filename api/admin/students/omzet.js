import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getTransactions } from '../../../lib/srs-customers-client.js';
import { readVerenigingMap, lookupVerenigingByCustomerId } from '../../../lib/students-vereniging-store.js';
import { getStoreNameByBranchId } from '../../../lib/branch-metrics.js';

/**
 * GET /api/admin/students/omzet?from=YYYY-MM-DD&until=YYYY-MM-DD
 *
 * Aggregeert SRS transacties in de gevraagde periode, gegroepeerd per
 * studentenvereniging.
 *
 * Bron:
 *   - getTransactions(period) → alle transacties in periode
 *   - students-vereniging map → customerId → vereniging lookup
 *
 * Periode default: dit jaar (1 januari → vandaag).
 *
 * Response:
 *   {
 *     success, period: { from, until, label },
 *     totals: { transactionCount, customerCount, verenigingCount, totalRevenue },
 *     byVereniging: [{
 *       name, type, customerCount, transactionCount, totalRevenue,
 *       avgPerTransaction, topBranchName, topBranchRevenue,
 *       topCustomers: [{ customerId, name, email, totalRevenue, transactionCount }]
 *     }],
 *     mapStatus: { totalWithVereniging, lastFullRebuildAt, isEmpty },
 *     generatedAt
 *   }
 */

/* Simpel in-memory cache zodat herhaalde pagerefresh niet opnieuw alle
   transacties uit SRS trekt. 5 min TTL. */
const CACHE_TTL_MS = 5 * 60 * 1000;
let CACHE = { ts: 0, key: '', data: null };

function clean(v) { return String(v || '').trim(); }
function moneyNum(v) { return Math.round(Number(v || 0) * 100) / 100; }

function defaultPeriod() {
  const now = new Date();
  const from = new Date(now.getFullYear(), 0, 1);
  return {
    from: from.toISOString().slice(0, 10),
    until: now.toISOString().slice(0, 10),
    label: `${now.getFullYear()} (jaar tot nu)`
  };
}

function buildLabelForPeriod(fromStr, untilStr) {
  if (!fromStr && !untilStr) return defaultPeriod().label;
  const f = fromStr || '—';
  const u = untilStr || '—';
  return `${f} t/m ${u}`;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  /* Periode bepalen */
  let from = clean(req.query.from || req.query.dateFrom);
  let until = clean(req.query.until || req.query.dateTo || req.query.to);
  if (!from && !until) {
    const def = defaultPeriod();
    from = def.from;
    until = def.until;
  }
  const label = buildLabelForPeriod(from, until);
  const forceRefresh = ['1', 'true', 'yes'].includes(String(req.query.refresh || '').toLowerCase());
  const cacheKey = `${from}::${until}`;

  if (!forceRefresh && CACHE.key === cacheKey && (Date.now() - CACHE.ts) < CACHE_TTL_MS) {
    return res.status(200).json({
      ...CACHE.data,
      cached: true,
      cacheAge: Math.round((Date.now() - CACHE.ts) / 1000)
    });
  }

  try {
    /* 1. Vereniging-map */
    const map = await readVerenigingMap();
    const totalInMap = Object.keys(map.customers || {}).length;

    if (!totalInMap) {
      return res.status(200).json({
        success: true,
        period: { from, until, label },
        totals: { transactionCount: 0, customerCount: 0, verenigingCount: 0, totalRevenue: 0 },
        byVereniging: [],
        mapStatus: { totalWithVereniging: 0, lastFullRebuildAt: null, isEmpty: true },
        message: 'Vereniging-cache is leeg. Klik "Cache herbouwen" om alle SRS klanten te scannen.',
        generatedAt: new Date().toISOString()
      });
    }

    /* 2. Transacties ophalen in periode (ALLE klanten, periodieke filter) */
    const { transactions = [] } = await getTransactions({
      from: from ? `${from}T00:00:00` : '',
      until: until ? `${until}T23:59:59` : ''
    });

    /* 3. Aggregeer per vereniging */
    const byVerenigingMap = new Map();
    const uniqueCustomers = new Set();
    let totalRevenue = 0;
    let matchedTxCount = 0;

    for (const tx of transactions) {
      const cid = clean(tx.customerId);
      if (!cid) continue;
      const customer = lookupVerenigingByCustomerId(map, cid);
      if (!customer) continue; /* Niet bij vereniging */
      const verName = customer.vereniging;
      if (!verName) continue;

      const revenue = Number(tx.total || 0);
      totalRevenue += revenue;
      uniqueCustomers.add(cid);
      matchedTxCount += 1;

      const verKey = verName.toLowerCase();
      const entry = byVerenigingMap.get(verKey) || {
        name: verName,
        type: customer.verenigingType || '',
        customerIds: new Set(),
        transactionCount: 0,
        totalRevenue: 0,
        byBranchMap: new Map(),
        byCustomerMap: new Map()
      };
      entry.customerIds.add(cid);
      entry.transactionCount += 1;
      entry.totalRevenue += revenue;
      /* Per branch */
      const branchName = getStoreNameByBranchId(tx.branchId) || `Branch ${tx.branchId || '?'}`;
      const bEntry = entry.byBranchMap.get(branchName) || { name: branchName, revenue: 0, transactionCount: 0 };
      bEntry.revenue += revenue;
      bEntry.transactionCount += 1;
      entry.byBranchMap.set(branchName, bEntry);
      /* Per klant */
      const cEntry = entry.byCustomerMap.get(cid) || {
        customerId: cid,
        name: customer.name || cid,
        email: customer.email || '',
        totalRevenue: 0,
        transactionCount: 0
      };
      cEntry.totalRevenue += revenue;
      cEntry.transactionCount += 1;
      entry.byCustomerMap.set(cid, cEntry);

      byVerenigingMap.set(verKey, entry);
    }

    const byVereniging = Array.from(byVerenigingMap.values())
      .map((v) => {
        const branches = Array.from(v.byBranchMap.values()).sort((a, b) => b.revenue - a.revenue);
        const customers = Array.from(v.byCustomerMap.values()).sort((a, b) => b.totalRevenue - a.totalRevenue);
        const topBranch = branches[0] || { name: '—', revenue: 0 };
        return {
          name: v.name,
          type: v.type,
          customerCount: v.customerIds.size,
          transactionCount: v.transactionCount,
          totalRevenue: moneyNum(v.totalRevenue),
          avgPerTransaction: v.transactionCount > 0 ? moneyNum(v.totalRevenue / v.transactionCount) : 0,
          avgPerCustomer: v.customerIds.size > 0 ? moneyNum(v.totalRevenue / v.customerIds.size) : 0,
          topBranchName: topBranch.name,
          topBranchRevenue: moneyNum(topBranch.revenue),
          branches: branches.slice(0, 10).map((b) => ({ ...b, revenue: moneyNum(b.revenue) })),
          topCustomers: customers.slice(0, 10).map((c) => ({ ...c, totalRevenue: moneyNum(c.totalRevenue) }))
        };
      })
      .sort((a, b) => b.totalRevenue - a.totalRevenue);

    const response = {
      success: true,
      period: { from, until, label },
      totals: {
        transactionCount: matchedTxCount,
        allTransactionCount: transactions.length,
        customerCount: uniqueCustomers.size,
        verenigingCount: byVereniging.length,
        totalRevenue: moneyNum(totalRevenue)
      },
      byVereniging,
      mapStatus: {
        totalWithVereniging: totalInMap,
        lastFullRebuildAt: map.lastFullRebuildAt,
        isEmpty: false
      },
      generatedAt: new Date().toISOString()
    };

    CACHE = { ts: Date.now(), key: cacheKey, data: response };
    return res.status(200).json({ ...response, cached: false });
  } catch (error) {
    console.error('[admin/students/omzet] error:', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Omzet ophalen mislukt.'
    });
  }
}
