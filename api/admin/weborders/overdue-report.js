// api/admin/weborders/overdue-report.js

import { isAdmin } from '../../../lib/request-guards.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function emptyPayload(note = '') {
  return {
    success: true,
    degraded: true,
    source: 'safe_empty_fallback',
    note,
    ownerLogic: 'order-line-current-branch',
    deadlineHours: 48,
    totals: {
      openCount: 0,
      openLineCount: 0,
      overdueCount: 0,
      overdueLineCount: 0,
      storeCount: 0
    },
    rows: []
  };
}

function getAgeInHours(dateValue) {
  if (!dateValue) return 0;

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 0;

  return Math.max(0, Math.round((Date.now() - date.getTime()) / 36e5));
}

function fallbackNormalizeWeborder(item = {}) {
  const fulfilmentStore =
    item.currentStore ||
    item.huidigFiliaalNaam ||
    item.huidigFiliaal ||
    item.fulfilmentStore ||
    item.fulfillmentStore ||
    item.store ||
    item.branchName ||
    '';

  const fulfilmentBranchId =
    item.currentBranchId ||
    item.huidigBranchId ||
    item.fulfilmentBranchId ||
    item.fulfillmentBranchId ||
    item.branchId ||
    '';

  const createdAt =
    item.createdAt ||
    item.orderDate ||
    item.created ||
    item.dateTime ||
    '';

  return {
    ...item,
    orderNr: item.orderNr || item.orderId || item.leveropdracht || '',
    orderId: item.orderId || item.orderNr || item.leveropdracht || '',
    status: item.status || item.srsStatus || item.fulfillmentStatus || 'open',
    fulfilmentStore,
    fulfillmentStore: fulfilmentStore,
    currentStore: fulfilmentStore,
    fulfilmentBranchId,
    fulfillmentBranchId: fulfilmentBranchId,
    currentBranchId: fulfilmentBranchId,
    createdAt,
    ageHours: getAgeInHours(createdAt)
  };
}

function makeSafeRows(rows = []) {
  return rows.map((row) => ({
    store: row.store || 'Onbekend',
    openCount: Number(row.openCount || 0),
    openLineCount: Number(row.openLineCount || 0),
    overdueCount: Number(row.overdueCount || 0),
    overdueLineCount: Number(row.overdueLineCount || 0),
    overdueRate: Number(row.overdueRate || 0),
    oldestAgeHours: Number(row.oldestAgeHours || 0),
    items: Array.isArray(row.items) ? row.items.slice(0, 100) : []
  }));
}

async function getSafeWeborders() {
  try {
    const srsClient = await import('../../../lib/srs-open-weborders-client.js');

    if (typeof srsClient.getSrsOpenWeborders !== 'function') {
      return {
        source: 'safe_empty_fallback',
        degraded: true,
        note: 'getSrsOpenWeborders bestaat niet in lib/srs-open-weborders-client.js.',
        items: []
      };
    }

    return await srsClient.getSrsOpenWeborders({});
  } catch (error) {
    console.error('[admin/weborders/overdue-report] srs import/read failed:', error);

    return {
      source: 'safe_empty_fallback',
      degraded: true,
      note: `Openstaande weborders konden niet uit SRS/local store worden geladen: ${error.message || error}`,
      items: []
    };
  }
}

async function getHelpers() {
  try {
    const helpers = await import('../../../lib/weborder-request-store.js');

    return {
      normalizeWeborder: helpers.normalizeWeborder || fallbackNormalizeWeborder,
      summarizeOverdueByStore: helpers.summarizeOverdueByStore || (() => []),
      isOpenWeborderStatus: helpers.isOpenWeborderStatus || (() => true)
    };
  } catch (error) {
    console.error('[admin/weborders/overdue-report] helper import failed:', error);

    return {
      normalizeWeborder: fallbackNormalizeWeborder,
      summarizeOverdueByStore: () => [],
      isOpenWeborderStatus: () => true
    };
  }
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  if (!isAdmin(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  try {
    const result = await getSafeWeborders();

    const {
      normalizeWeborder,
      summarizeOverdueByStore
    } = await getHelpers();

    const items = (result.items || []).map(normalizeWeborder);
    const safeRows = makeSafeRows(summarizeOverdueByStore(items));

    const openCount = safeRows.reduce((sum, row) => sum + Number(row.openCount || 0), 0);
    const openLineCount = safeRows.reduce((sum, row) => sum + Number(row.openLineCount || 0), 0);
    const overdueCount = safeRows.reduce((sum, row) => sum + Number(row.overdueCount || 0), 0);
    const overdueLineCount = safeRows.reduce((sum, row) => sum + Number(row.overdueLineCount || 0), 0);

    return res.status(200).json({
      success: true,
      source: result.source || 'srs_open_weborders',
      note: result.note || '',
      degraded: Boolean(result.degraded),
      ownerLogic: 'order-line-current-branch',
      ownerLogicNote: 'Adminrapportage telt openstaande orderregels op Huidig filiaal. Het magazijn telt mee als eigen, aanspreekbare rij ("GENTS Magazijn"). Regels met Huidig filiaal Klant of geleverd/geannuleerd/afgerond tellen niet mee.',
      deadlineHours: 48,
      totals: {
        openCount,
        openLineCount,
        overdueCount,
        overdueLineCount,
        storeCount: safeRows.length
      },
      rows: safeRows
    });
  } catch (error) {
    console.error('[admin/weborders/overdue-report]', error);

    return res.status(200).json(
      emptyPayload(
        error.message ||
        'Openstaande weborders konden niet worden opgehaald. Lege fallback gebruikt zodat de admin blijft laden.'
      )
    );
  }
}
