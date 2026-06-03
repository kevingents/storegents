/**
 * GET /api/admin/top-customers-srs?store=<store>&period=year|month|lifetime&limit=8&metric=spend|count
 *
 * Top klanten op basis van SRS kassa-transacties voor een specifieke
 * winkel. Aggregeert SRS getTransactions() per CustomerId, filtert op
 * branchId, geeft top-N terug.
 *
 * Response:
 *   {
 *     success, store, branchId, period,
 *     scanned: <aantal transacties>,
 *     customers: [{ customerId, name, email, orders, spend, lastOrderAt }]
 *   }
 */

import { getTransactions, getCustomers } from '../../lib/srs-customers-client.js';
import { getBranchIdByStore, getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query?.adminToken ||
    req.query?.admin_token ||
    req.query?.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(adminToken && token && token === adminToken);
}

function isoDateTime(date) {
  return date.toISOString().slice(0, 19);
}
function computeRange(period) {
  const now = new Date();
  const from = new Date(now);
  if (period === 'month') from.setDate(from.getDate() - 30);
  else if (period === 'lifetime') from.setFullYear(from.getFullYear() - 5);
  else from.setFullYear(from.getFullYear() - 1); /* year default */
  from.setHours(0, 0, 0, 0);
  return { from: isoDateTime(from), until: isoDateTime(now) };
}

async function enrichWithCustomerData(topCustomers) {
  /* Fetch klant-details voor top-N parallel.
     getCustomers ondersteunt query/email/customerId — we doen ze per stuk. */
  await Promise.all(topCustomers.map(async (c) => {
    if (!c.customerId) return;
    try {
      const r = await getCustomers({ customerId: c.customerId });
      const cust = (r.customers || [])[0];
      if (cust) {
        c.name = [cust.firstName, cust.lastName].filter(Boolean).join(' ') || cust.name || c.customerId;
        c.email = cust.email || '';
      }
    } catch (e) {
      /* Behoud customerId als naam fallback */
      c.name = c.name || `Klant ${c.customerId}`;
    }
  }));
}

export const maxDuration = 60;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  const store = String(req.query.store || '').trim();
  const period = String(req.query.period || 'year').toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 8));
  const metric = String(req.query.metric || 'spend').toLowerCase(); /* 'spend' | 'count' */

  if (!store) return res.status(400).json({ success: false, message: 'store query-param is verplicht.' });

  const branchId = getBranchIdByStore(store);
  if (!branchId) {
    return res.status(400).json({ success: false, message: `Geen SRS branchId gevonden voor winkel "${store}".` });
  }

  const { from, until } = computeRange(period);

  try {
    /* Haal alle transacties voor de periode op (zonder customerId-filter).
       Filter daarna in-memory op branchId. */
    const result = await getTransactions({ from, until });
    const all = Array.isArray(result?.transactions) ? result.transactions : [];
    const branchTx = all.filter((tx) => String(tx.branchId || '') === String(branchId));

    /* Aggregeer per customerId */
    const byCustomer = new Map();
    for (const tx of branchTx) {
      const id = String(tx.customerId || '').trim();
      if (!id) continue;
      const cur = byCustomer.get(id) || {
        customerId: id,
        name: '',
        email: '',
        orders: 0,
        spend: 0,
        lastOrderAt: null
      };
      cur.orders += 1;
      cur.spend += Number(tx.total || 0);
      if (tx.dateTime && (!cur.lastOrderAt || tx.dateTime > cur.lastOrderAt)) {
        cur.lastOrderAt = tx.dateTime;
      }
      byCustomer.set(id, cur);
    }

    /* Top-N */
    const sorted = [...byCustomer.values()].sort((a, b) => {
      if (metric === 'count') return b.orders - a.orders;
      return b.spend - a.spend;
    });
    const top = sorted.slice(0, limit);

    /* Verrijk met klant-naam/email via separate calls */
    await enrichWithCustomerData(top);

    return res.status(200).json({
      success: true,
      store,
      branchId,
      branchStoreName: getStoreNameByBranchId(branchId),
      period,
      metric,
      from,
      until,
      scanned: all.length,
      branchScanned: branchTx.length,
      uniqueCustomers: byCustomer.size,
      customers: top.map((c) => ({
        ...c,
        spend: Math.round(c.spend * 100) / 100,
        avgOrder: c.orders > 0 ? Math.round((c.spend / c.orders) * 100) / 100 : 0
      }))
    });
  } catch (error) {
    console.error('[top-customers-srs]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Top klanten kon niet worden opgehaald uit SRS.'
    });
  }
}
