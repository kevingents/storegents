import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getLocationsMap } from '../../lib/shopify-locations.js';
import { getCustomers } from '../../lib/srs-customers-client.js';
import { listBranches, getStoreNameByBranchId } from '../../lib/branch-metrics.js';
import { applyStoreScope } from '../../lib/caller-store-scope.js';
import { readReportCache, writeReportCache } from '../../lib/gents-report-cache-store.js';

/**
 * GET /api/admin/store-customer-overview?period=month
 *
 * Combineert per winkel:
 *   - Top 5 klanten op omzet
 *   - % terugkerende klanten (binnen 60 dagen)
 *   - Aantal nieuwe inschrijvingen (uit SRS weekly-report)
 *   - Aantal nieuwe inschrijvingen ZONDER e-mail (compliance signaal)
 *
 * Globaal:
 *   - Channel split (online vs winkel) + 12-maanden trend
 *
 * Bronnen:
 *   - Shopify orders.json (per-store + per-customer aggregatie)
 *   - Shopify locations.json (location_id → winkelnaam mapping)
 *   - /api/admin/customers/weekly-report (SRS customer inschrijvingen)
 */

const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || '';
const SHOPIFY_TOKEN = process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ADMIN_API_TOKEN || '';
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || '2025-01';
const RETURNING_WINDOW_DAYS = 60;

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || '').trim();
  if (!adminToken) return false;
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function clean(value) { return String(value || '').trim(); }
function moneyNumber(value) { return Math.round(Number(value || 0) * 100) / 100; }

function computeRange(period) {
  const now = new Date();
  const from = new Date(now);
  if (period === 'week') { from.setDate(from.getDate() - 7); }
  else if (period === 'year') { from.setFullYear(from.getFullYear() - 1); }
  else { from.setDate(from.getDate() - 30); /* month */ }
  from.setHours(0, 0, 0, 0);
  /* Voor returning rate hebben we orders 60 dagen vóór "from" ook nodig */
  const lookbackFrom = new Date(from);
  lookbackFrom.setDate(lookbackFrom.getDate() - RETURNING_WINDOW_DAYS);
  return { from, to: now, lookbackFrom };
}

function deriveStoreFromOrder(o, locationsMap) {
  /* location_id → echte winkel-naam (Shopify Locations API) */
  if (o.location_id && locationsMap?.has(String(o.location_id))) {
    const loc = locationsMap.get(String(o.location_id));
    if (loc?.name) return loc.name;
  }
  const src = String(o.source_name || '').toLowerCase();
  if (src === 'pos') {
    const tags = String(o.tags || '').split(',').map((t) => t.trim());
    const storeTag = tags.find((t) => /^store:|^winkel:/i.test(t));
    if (storeTag) return storeTag.replace(/^(store|winkel):/i, '').trim();
    if (o.location_id) return `Locatie ${o.location_id}`;
    return 'GENTS Winkel (POS)';
  }
  if (src && src !== 'web' && src !== 'shopify_draft_order') return src.charAt(0).toUpperCase() + src.slice(1);
  return 'Webshop';
}

function deriveChannel(o) {
  /* Online = web checkout; Winkel = POS / fysieke winkel */
  const src = String(o.source_name || '').toLowerCase();
  if (src === 'pos') return 'store';
  if (o.location_id) return 'store'; /* heeft location → fysiek */
  return 'online';
}

async function fetchOrders({ from, to, maxOrders }) {
  if (!SHOPIFY_DOMAIN || !SHOPIFY_TOKEN) {
    throw new Error('SHOPIFY_STORE_DOMAIN of SHOPIFY_ADMIN_ACCESS_TOKEN ontbreekt in Vercel.');
  }
  const shop = SHOPIFY_DOMAIN.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const orders = [];
  let url = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/orders.json?status=any&created_at_min=${from.toISOString()}&created_at_max=${to.toISOString()}&limit=250&fields=id,name,created_at,total_price,customer,source_name,location_id,tags`;

  while (url && orders.length < maxOrders) {
    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_TOKEN, Accept: 'application/json' }
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Shopify orders.json ${resp.status} — ${text.slice(0, 200)}`);
    }
    const data = await resp.json();
    orders.push(...(data.orders || []));
    const linkHeader = resp.headers.get('link') || resp.headers.get('Link') || '';
    const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
    url = nextMatch ? nextMatch[1] : null;
  }
  return orders.slice(0, maxOrders);
}

/**
 * Direct SRS-fetch (vervangt de internal HTTP roundtrip).
 * Per branch aggregeert nieuwe klanten + zonder-email count.
 *
 * Returnt:
 *   {
 *     byBranchId: Map<branchId, { newCustomers, withEmail, withoutEmail, emailRate, mailingOptIn }>,
 *     byStoreName: Map<storeName, ...> (zelfde data, key op naam),
 *     totals: { newCustomers, withEmail, withoutEmail, emailRate }
 *   }
 */
async function fetchSrsInschrijvingen(dateFrom, dateTo) {
  const empty = {
    byBranchId: new Map(),
    byStoreName: new Map(),
    totals: { newCustomers: 0, withEmail: 0, withoutEmail: 0, emailRate: 0, mailingOptIn: 0 }
  };

  try {
    const result = await getCustomers({
      createdFrom: `${dateFrom}T00:00:00`,
      createdUntil: `${dateTo}T23:59:59`
    });
    const customers = Array.isArray(result?.customers) ? result.customers : [];

    const byBranchId = new Map();
    let allWithEmail = 0;
    let allWithoutEmail = 0;
    let allMailingOptIn = 0;

    customers.forEach((c) => {
      const branchId = String(
        c.registeredInBranchId || c.RegisteredInBranchId ||
        c.branchId || c.BranchId ||
        c.storeBranchId || c.StoreBranchId || ''
      ).trim();
      const email = String(c.email || c.Email || c.emailAddress || '').trim();
      const allowMail = ['true', '1', 'yes', 'ja'].includes(
        String(c.allowMailings ?? c.AllowMailings ?? '').toLowerCase()
      );

      if (email) allWithEmail++; else allWithoutEmail++;
      if (allowMail) allMailingOptIn++;

      if (!branchId) return;
      const cur = byBranchId.get(branchId) || { newCustomers: 0, withEmail: 0, withoutEmail: 0, mailingOptIn: 0 };
      cur.newCustomers++;
      if (email) cur.withEmail++; else cur.withoutEmail++;
      if (allowMail) cur.mailingOptIn++;
      byBranchId.set(branchId, cur);
    });

    /* Bereken emailRate per branch + voor totalen */
    for (const [bid, val] of byBranchId) {
      val.emailRate = val.newCustomers ? Math.round((val.withEmail / val.newCustomers) * 100) : 0;
    }

    /* Build byStoreName index voor fuzzy matching */
    const byStoreName = new Map();
    for (const [bid, val] of byBranchId) {
      const name = getStoreNameByBranchId(bid);
      if (name) byStoreName.set(name, { ...val, branchId: bid, store: name });
    }

    const totalNew = allWithEmail + allWithoutEmail;
    return {
      byBranchId,
      byStoreName,
      totals: {
        newCustomers: totalNew,
        withEmail: allWithEmail,
        withoutEmail: allWithoutEmail,
        mailingOptIn: allMailingOptIn,
        emailRate: totalNew ? Math.round((allWithEmail / totalNew) * 100) : 0
      }
    };
  } catch (error) {
    console.error('[store-customer-overview] SRS getCustomers fout:', error.message);
    return empty;
  }
}

export const maxDuration = 60;

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const period = clean(req.query.period || 'month').toLowerCase();
  const maxOrders = Math.max(200, Math.min(3000, Number(req.query.maxOrders || 1500)));
  const { from, to, lookbackFrom } = computeRange(period);

  /* Cache: deze overview doet een zware live Shopify-scan (~40s). Een cron
     ververst 'm periodiek (api/cron/customer-overview-refresh) en de pagina leest
     hier de cache → instant. ?refresh=1 forceert een verse berekening (cron). */
  const forceRefresh = ['1', 'true'].includes(clean(req.query.refresh).toLowerCase());
  if (!forceRefresh) {
    const cached = await readReportCache('store-customer-overview', period, 0);
    if (cached?.data?.stores) {
      const stores = applyStoreScope(req, cached.data.stores, (s) => s.store);
      return res.status(200).json({
        ...cached.data,
        stores,
        cached: true,
        refreshedAt: cached.cachedAt,
        ageMinutes: Math.round((cached.ageMs || 0) / 60000),
      });
    }
  }

  try {
    /* Parallel: Shopify orders (huidige + lookback) + SRS inschrijvingen + Shopify Locations */
    const [orders, srsData, locationsMap] = await Promise.all([
      fetchOrders({ from: lookbackFrom, to, maxOrders }),
      fetchSrsInschrijvingen(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)),
      getLocationsMap().catch(() => new Map())
    ]);

    /* Channel-split trend: laatste 12 maanden online vs winkel.
       Voor de trend halen we orders 12mnd terug op met aparte fetch
       om de current/lookback fetch lichter te houden. */
    let channelTrend = null;
    if (clean(req.query.includeTrend || '1') === '1') {
      try {
        const trendFrom = new Date();
        trendFrom.setMonth(trendFrom.getMonth() - 12);
        trendFrom.setDate(1);
        trendFrom.setHours(0, 0, 0, 0);
        const trendOrders = await fetchOrders({ from: trendFrom, to, maxOrders: 5000 });
        const byMonth = new Map();
        for (const o of trendOrders) {
          const d = new Date(o.created_at);
          if (isNaN(d)) continue;
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          const ch = deriveChannel(o);
          const cur = byMonth.get(key) || { month: key, online: 0, store: 0, onlineSpend: 0, storeSpend: 0 };
          cur[ch] += 1;
          cur[ch + 'Spend'] += Number(o.total_price || 0);
          byMonth.set(key, cur);
        }
        const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
        channelTrend = months.map((m) => {
          const total = m.online + m.store;
          return {
            ...m,
            total,
            onlinePct: total ? Math.round((m.online / total) * 100) : 0,
            storePct: total ? Math.round((m.store / total) * 100) : 0,
            onlineSpend: moneyNumber(m.onlineSpend),
            storeSpend: moneyNumber(m.storeSpend),
            totalSpend: moneyNumber(m.onlineSpend + m.storeSpend)
          };
        });
      } catch (_) { channelTrend = null; }
    }

    /* SRS data — al per store-naam geïndexeerd */
    const srsByStore = srsData.byStoreName;

    /* Per-store customer aggregatie */
    const byStore = new Map();
    /* Globale channel-counts in periode (for headline %) */
    let totalOnline = 0;
    let totalStore = 0;
    let totalOnlineSpend = 0;
    let totalStoreSpend = 0;
    for (const o of orders) {
      const cust = o.customer || {};
      const email = clean(cust.email).toLowerCase();
      const customerId = clean(cust.id);
      const key = email || customerId;
      if (!key) continue;
      const store = deriveStoreFromOrder(o, locationsMap);
      const orderDateRaw = new Date(o.created_at);
      if (orderDateRaw >= from) {
        const ch = deriveChannel(o);
        if (ch === 'online') { totalOnline++; totalOnlineSpend += Number(o.total_price || 0); }
        else { totalStore++; totalStoreSpend += Number(o.total_price || 0); }
      }
      if (!byStore.has(store)) byStore.set(store, new Map());
      const custMap = byStore.get(store);
      const name = clean([cust.first_name, cust.last_name].filter(Boolean).join(' ')) || email;
      const orderDate = new Date(o.created_at);
      const cur = custMap.get(key) || {
        key, name, email, customerId,
        orders: 0,
        ordersInPeriod: 0,
        ordersInLookback: 0,
        spend: 0,
        dates: []
      };
      cur.orders += 1;
      cur.spend += Number(o.total_price || 0);
      cur.dates.push(orderDate);
      if (orderDate >= from) cur.ordersInPeriod += 1;
      else cur.ordersInLookback += 1;
      custMap.set(key, cur);
    }

    /* Helper: compute Shopify-side stats per winkel (return same shape voor 0-orders winkels) */
    function computeShopifyStats(custMap) {
      if (!custMap || !custMap.size) {
        return { uniqueCustomers: 0, totalOrders: 0, totalSpend: 0, returningCount: 0, returningRate: 0, top: [] };
      }
      const list = [...custMap.values()];
      const inPeriod = list.filter((c) => c.ordersInPeriod > 0);

      let returningCount = 0;
      inPeriod.forEach((c) => {
        const sortedDates = [...c.dates].sort((a, b) => a - b);
        for (let i = 1; i < sortedDates.length; i++) {
          const daysBetween = (sortedDates[i] - sortedDates[i - 1]) / 86400000;
          if (sortedDates[i] >= from && daysBetween <= RETURNING_WINDOW_DAYS) {
            returningCount++;
            break;
          }
        }
      });
      const returningRate = inPeriod.length ? Math.round((returningCount / inPeriod.length) * 100) : 0;

      const top = list
        .filter((c) => c.ordersInPeriod > 0)
        .map((c) => ({
          key: c.key, name: c.name, email: c.email, customerId: c.customerId,
          orders: c.ordersInPeriod,
          spend: moneyNumber(c.spend),
          avgOrder: c.ordersInPeriod ? moneyNumber(c.spend / c.orders) : 0
        }))
        .sort((a, b) => b.spend - a.spend)
        .slice(0, 5);

      return {
        uniqueCustomers: inPeriod.length,
        totalOrders: inPeriod.reduce((s, c) => s + c.ordersInPeriod, 0),
        totalSpend: moneyNumber(inPeriod.reduce((s, c) => s + c.spend, 0)),
        returningCount, returningRate, top
      };
    }

    /* Master-lijst van winkels: combineer ALLE SRS-branches (uit branch-metrics)
       + alle Shopify-aggregaties die niet matchen (bv 'Webshop'). */
    const allBranches = listBranches();
    const stores = [];
    const usedStoreKeys = new Set();

    /* Step 1: voor elke SRS-branch → maak een entry, voeg Shopify-data toe als available */
    allBranches.forEach((branch) => {
      const branchName = branch.store;
      const srsEntry = srsByStore.get(branchName) || null;
      const custMap = byStore.get(branchName);
      const shopifyStats = computeShopifyStats(custMap);
      usedStoreKeys.add(branchName);

      stores.push({
        store: branchName,
        branchId: branch.branchId,
        source: 'srs_branch',
        ...shopifyStats,
        newRegistrations: srsEntry?.newCustomers || 0,
        newWithoutEmail: srsEntry?.withoutEmail || 0,
        newWithEmail: srsEntry?.withEmail || 0,
        newEmailRate: srsEntry?.emailRate ?? null,
        newMailingOptIn: srsEntry?.mailingOptIn || 0
      });
    });

    /* Step 2: Shopify-stores die GEEN match hebben (bv 'Webshop', 'Locatie xxx') */
    for (const [storeName, custMap] of byStore) {
      if (usedStoreKeys.has(storeName)) continue;
      const shopifyStats = computeShopifyStats(custMap);
      stores.push({
        store: storeName,
        branchId: null,
        source: 'shopify_only',
        ...shopifyStats,
        newRegistrations: 0,
        newWithoutEmail: 0,
        newWithEmail: 0,
        newEmailRate: null,
        newMailingOptIn: 0
      });
    }

    /* Sort: stores met data eerst (omzet of inschrijvingen), winkels zonder data laatst */
    stores.sort((a, b) => {
      const aHas = (a.totalSpend > 0 || a.newRegistrations > 0) ? 1 : 0;
      const bHas = (b.totalSpend > 0 || b.newRegistrations > 0) ? 1 : 0;
      if (aHas !== bHas) return bHas - aHas;
      const aScore = (a.totalSpend || 0) + (a.newRegistrations || 0) * 100;
      const bScore = (b.totalSpend || 0) + (b.newRegistrations || 0) * 100;
      return bScore - aScore;
    });

    /* Channel split headline */
    const totalCount = totalOnline + totalStore;
    const channelSplit = {
      online: totalOnline,
      store: totalStore,
      total: totalCount,
      onlinePct: totalCount ? Math.round((totalOnline / totalCount) * 100) : 0,
      storePct: totalCount ? Math.round((totalStore / totalCount) * 100) : 0,
      onlineSpend: moneyNumber(totalOnlineSpend),
      storeSpend: moneyNumber(totalStoreSpend),
      totalSpend: moneyNumber(totalOnlineSpend + totalStoreSpend)
    };

    /* Volledige (ongescopede) uitkomst → cache, zodat 'm voor elke gebruiker
       herbruikbaar is. De winkel-scope (shop_manager ziet alleen eigen winkels)
       passen we PAS bij het serveren toe. */
    const result = {
      success: true,
      period,
      range: { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) },
      returningWindowDays: RETURNING_WINDOW_DAYS,
      ordersScanned: orders.length,
      locationsMatched: locationsMap.size,
      srsInschrijvingenTotals: srsData.totals,
      srsBranchesWithData: srsData.byBranchId.size,
      channelSplit,
      channelTrend,
      stores
    };
    try { await writeReportCache('store-customer-overview', period, result); }
    catch (e) { console.warn('[store-customer-overview] cache-write:', e.message); }

    return res.status(200).json({
      ...result,
      stores: applyStoreScope(req, stores, (s) => s.store),
      cached: false
    });
  } catch (error) {
    console.error('[admin/store-customer-overview]', error);
    return res.status(200).json({
      success: true,
      configured: !String(error.message || '').includes('ontbreekt in Vercel'),
      error: error.message || String(error),
      message: 'Overview kon niet worden berekend.',
      stores: []
    });
  }
}
