// api/admin/weborders/overdue-report.js

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '12345';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;

  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  return token === ADMIN_TOKEN;
}

function emptyPayload(note = '') {
  return {
    success: true,
    degraded: true,
    source: 'safe_empty_fallback',
    note,
    deadlineHours: 48,
    totals: {
      openCount: 0,
      overdueCount: 0,
      storeCount: 0
    },
    rows: []
  };
}

function fallbackNormalizeWeborder(item = {}) {
  const fulfilmentStore =
    item.fulfilmentStore ||
    item.fulfillmentStore ||
    item.store ||
    item.branchName ||
    '';

  const fulfilmentBranchId =
    item.fulfilmentBranchId ||
    item.fulfillmentBranchId ||
    item.branchId ||
    '';

  const createdAt =
    item.createdAt ||
    item.orderDate ||
    item.created ||
    '';

  return {
    ...item,
    orderNr: item.orderNr || item.orderId || '',
    orderId: item.orderId || item.orderNr || '',
    status: item.status || item.srsStatus || item.fulfillmentStatus || 'open',
    fulfilmentStore,
    fulfillmentStore: fulfilmentStore,
    fulfilmentBranchId,
    fulfillmentBranchId: fulfilmentBranchId,
    createdAt,
    ageHours: getAgeInHours(createdAt)
  };
}

function getAgeInHours(dateValue) {
  if (!dateValue) return 0;

  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return 0;

  return Math.max(0, Math.round((Date.now() - date.getTime()) / 36e5));
}

function fallbackIsOpenWeborderStatus(status) {
  return [
    'accepted',
    'pending',
    'open',
    'srs_created',
    'pending_srs',
    'label_created',
    'in_behandeling',
    'te_verzenden',
    'failed_label'
  ].includes(String(status || '').toLowerCase());
}

function fallbackSummarizeOverdueByStore(requests = []) {
  const normalized = requests
    .map(fallbackNormalizeWeborder)
    .filter((item) => fallbackIsOpenWeborderStatus(item.status));

  const map = new Map();

  normalized.forEach((item) => {
    const store =
      item.fulfilmentStore ||
      item.fulfillmentStore ||
      item.sellingStore ||
      'Onbekend';

    if (!map.has(store)) {
      map.set(store, {
        store,
        openCount: 0,
        overdueCount: 0,
        overdueRate: 0,
        oldestAgeHours: 0
      });
    }

    const row = map.get(store);
    const ageHours = Number(item.ageHours || getAgeInHours(item.createdAt));
    const overdue = ageHours >= 48;

    row.openCount += 1;
    row.oldestAgeHours = Math.max(row.oldestAgeHours, ageHours);

    if (overdue) {
      row.overdueCount += 1;
    }

    row.overdueRate = row.openCount
      ? Math.round((row.overdueCount / row.openCount) * 100)
      : 0;
  });

  return Array.from(map.values()).sort((a, b) =>
    b.overdueCount - a.overdueCount ||
    b.oldestAgeHours - a.oldestAgeHours ||
    a.store.localeCompare(b.store)
  );
}

function makeSafeRows(rows = []) {
  return rows.map((row) => ({
    store: row.store || 'Onbekend',
    openCount: Number(row.openCount || 0),
    overdueCount: Number(row.overdueCount || 0),
    overdueRate: Number(row.overdueRate || 0),
    oldestAgeHours: Number(row.oldestAgeHours || 0)
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
      isOpenWeborderStatus: helpers.isOpenWeborderStatus || fallbackIsOpenWeborderStatus,
      summarizeOverdueByStore: helpers.summarizeOverdueByStore || fallbackSummarizeOverdueByStore
    };
  } catch (error) {
    console.error('[admin/weborders/overdue-report] helper import failed:', error);

    return {
      normalizeWeborder: fallbackNormalizeWeborder,
      isOpenWeborderStatus: fallbackIsOpenWeborderStatus,
      summarizeOverdueByStore: fallbackSummarizeOverdueByStore
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

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  try {
    const result = await getSafeWeborders();

    const {
      normalizeWeborder,
      isOpenWeborderStatus,
      summarizeOverdueByStore
    } = await getHelpers();

    const items = (result.items || []).map(normalizeWeborder);
    const openItems = items.filter((item) => isOpenWeborderStatus(item.status));
    const rawRows = summarizeOverdueByStore(items);
    const safeRows = makeSafeRows(rawRows);

    const overdueCount = safeRows.reduce(
      (sum, row) => sum + Number(row.overdueCount || 0),
      0
    );

    return res.status(200).json({
      success: true,
      source: result.source || 'srs_open_weborders',
      note: result.note || '',
      degraded: Boolean(result.degraded),
      deadlineHours: 48,
      totals: {
        openCount: openItems.length,
        overdueCount,
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
