import { listAllBranches } from '../../../lib/branch-metrics.js';
import { getOrderCancellations } from '../../../lib/order-cancellation-store.js';
import { listUnavailableOrderLines } from '../../../lib/unavailable-order-line-service.js';

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '12345';
const BRANCH_LOCATION_MAP = {
  '97': 'GENTS Magazijn',
  '99': 'GENTS Magazijn',
  '700': 'GENTS Showroom'
};

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const token = String(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization || req.query.adminToken || req.query.admin_token || '').replace(/^Bearer\s+/i, '').trim();
  return token === ADMIN_TOKEN;
}

function clean(value) { return String(value || '').trim(); }
function key(value) { return clean(value).toLowerCase().replace(/^\d+\s*-\s*/i, '').replace(/\s+/g, ' '); }

function resolveLocation(value) {
  const raw = clean(value);
  const normalized = key(raw);
  if (!raw) return '';
  if (BRANCH_LOCATION_MAP[raw]) return BRANCH_LOCATION_MAP[raw];
  if (normalized.includes('uitlevertafel') || normalized.includes('uitlever tafel')) return 'GENTS Magazijn';
  if (normalized.includes('magazijn') || normalized.includes('warehouse') || normalized.includes('webshop')) return 'GENTS Magazijn';
  if (normalized.includes('showroom')) return 'GENTS Showroom';
  return raw;
}

function typeForLocation(store) {
  const value = key(resolveLocation(store));
  if (value.includes('magazijn') || value.includes('warehouse') || value.includes('webshop')) return 'magazijn';
  if (value.includes('showroom')) return 'showroom';
  return 'winkel';
}

function dateValue(row = {}) { return row.createdAt || row.updatedAt || row.date || row.cancelledAt || row.orderDate || row.created || ''; }
function ageHours(value) {
  const date = new Date(value || 0);
  if (Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.round((Date.now() - date.getTime()) / 36e5));
}
function isLate(row = {}, fallbackHours = 48) {
  if (row.overdue === true || row.isOverdue === true) return true;
  return ageHours(dateValue(row)) >= Number(row.deadlineHours || fallbackHours || 48);
}

function addMetric(target, store, metric, amount = 1) {
  const resolved = resolveLocation(store);
  const item = target.get(key(resolved));
  if (!item) return;
  item[metric] = Number(item[metric] || 0) + Number(amount || 0);
}

function normalizeStatus(value) { return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' '); }
function isClosedStatus(value) {
  const status = normalizeStatus(value);
  return status.includes('closed') || status.includes('done') || status.includes('afgerond') || status.includes('verwerkt') || status.includes('geleverd') || status.includes('cancelled') || status.includes('canceled') || status.includes('geannuleerd');
}

function storeFromCancellation(row = {}) {
  const item = Array.isArray(row.items) && row.items.length ? row.items[0] : {};
  return resolveLocation(item.lastResponsibleStore || row.lastResponsibleStore || row.store || item.store || item.currentBranch || item.currentBranchId || item.branchId || item.originBranch || 'Onbekend');
}

function flattenCancellations(records = []) {
  return records.flatMap((record) => {
    const items = Array.isArray(record.items) && record.items.length ? record.items : [{}];
    return items.map((item, index) => ({
      ...record,
      lineIndex: index,
      store: resolveLocation(item.lastResponsibleStore || record.store || item.currentBranch || item.currentBranchId || item.branchId || item.originBranch || 'Onbekend'),
      status: clean(item.srsStatus || item.status || record.status || record.srsStatus || record.reason || ''),
      createdAt: record.createdAt || item.createdAt || '',
      updatedAt: record.updatedAt || item.updatedAt || '',
      amount: Number(item.amount || record.amount || 0)
    }));
  });
}

async function getWeborderRows() {
  try {
    const [client, helpers] = await Promise.all([
      import('../../../lib/srs-open-weborders-client.js'),
      import('../../../lib/weborder-request-store.js').catch(() => ({}))
    ]);
    if (typeof client.getSrsOpenWeborders !== 'function') return [];
    const result = await client.getSrsOpenWeborders({});
    const normalizeWeborder = helpers.normalizeWeborder || ((item) => item);
    const isOpenWeborderStatus = helpers.isOpenWeborderStatus || ((status) => !isClosedStatus(status));
    return (result.items || []).map(normalizeWeborder).filter((row) => isOpenWeborderStatus(row.status || row.srsStatus || row.fulfillmentStatus || 'open'));
  } catch (error) {
    console.error('[admin/dashboard/location-overview] weborders failed:', error);
    return [];
  }
}

function storeFromWeborder(row = {}) {
  if (row.warehouse === true || row.isWarehouse === true) return 'GENTS Magazijn';
  if (row.showroom === true || row.isShowroom === true) return 'GENTS Showroom';
  return resolveLocation(row.currentStore || row.fulfilmentStore || row.fulfillmentStore || row.huidigFiliaalNaam || row.huidigFiliaal || row.currentBranchName || row.branchName || row.store || row.currentBranchId || row.huidigBranchId || row.fulfilmentBranchId || row.fulfillmentBranchId || row.branchId || 'Onbekend');
}

function summarizeTotals(rows = []) {
  return rows.reduce((acc, row) => {
    acc.openOrders += Number(row.openOrders || 0);
    acc.lateOrders += Number(row.lateOrders || 0);
    acc.openDragers += Number(row.openDragers || 0);
    acc.lateDragers += Number(row.lateDragers || 0);
    acc.openExchanges += Number(row.openExchanges || 0);
    acc.lateExchanges += Number(row.lateExchanges || 0);
    acc.openUnavailable += Number(row.openUnavailable || 0);
    acc.failedUnavailable += Number(row.failedUnavailable || 0);
    return acc;
  }, { openOrders: 0, lateOrders: 0, openDragers: 0, lateDragers: 0, openExchanges: 0, lateExchanges: 0, openUnavailable: 0, failedUnavailable: 0 });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  try {
    const locations = new Map();
    listAllBranches().forEach((branch) => {
      locations.set(key(branch.store), {
        store: branch.store,
        branchId: branch.branchId,
        type: typeForLocation(branch.store),
        openOrders: 0,
        lateOrders: 0,
        openDragers: 0,
        lateDragers: 0,
        openExchanges: 0,
        lateExchanges: 0,
        openUnavailable: 0,
        failedUnavailable: 0
      });
    });
    const [weborders, cancellations, unavailable] = await Promise.all([
      getWeborderRows(),
      getOrderCancellations().catch((error) => { console.error('[admin/dashboard/location-overview] cancellations failed:', error); return []; }),
      listUnavailableOrderLines({ status: 'open' }).catch((error) => { console.error('[admin/dashboard/location-overview] unavailable failed:', error); return { rows: [] }; })
    ]);
    weborders.forEach((row) => {
      const store = storeFromWeborder(row);
      addMetric(locations, store, 'openOrders', 1);
      if (isLate(row, 48)) addMetric(locations, store, 'lateOrders', 1);
    });
    flattenCancellations(cancellations).forEach((row) => {
      if (isClosedStatus(row.status) && !normalizeStatus(row.status).includes('niet leverbaar') && !normalizeStatus(row.status).includes('unavailable')) return;
      addMetric(locations, storeFromCancellation(row), 'openExchanges', 1);
      if (isLate(row, 48)) addMetric(locations, storeFromCancellation(row), 'lateExchanges', 1);
    });
    (unavailable.rows || []).forEach((row) => {
      const store = resolveLocation(row.store || row.lastResponsibleStore || row.currentBranch || row.currentBranchId || row.branchId || 'Onbekend');
      addMetric(locations, store, 'openUnavailable', 1);
      if (row.error || normalizeStatus(row.status).includes('failed')) addMetric(locations, store, 'failedUnavailable', 1);
    });
    const rows = Array.from(locations.values()).map((row) => ({
      ...row,
      totalOpen: Number(row.openOrders || 0) + Number(row.openDragers || 0) + Number(row.openExchanges || 0) + Number(row.openUnavailable || 0),
      totalLate: Number(row.lateOrders || 0) + Number(row.lateDragers || 0) + Number(row.lateExchanges || 0)
    })).sort((a, b) => b.totalLate - a.totalLate || b.totalOpen - a.totalOpen || a.store.localeCompare(b.store, 'nl'));
    return res.status(200).json({ success: true, source: 'location_overview', generatedAt: new Date().toISOString(), totals: summarizeTotals(rows), rows });
  } catch (error) {
    console.error('[admin/dashboard/location-overview]', error);
    return res.status(500).json({ success: false, message: error.message || 'Locatieoverzicht kon niet worden opgebouwd.' });
  }
}
