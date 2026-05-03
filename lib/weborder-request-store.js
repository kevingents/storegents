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
    req.headers['authorization'] ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();

  return !ADMIN_TOKEN || token === ADMIN_TOKEN;
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

function basicNormalizeWeborder(item = {}) {
  return {
    ...item,
    status: item.status || item.srsStatus || item.fulfillmentStatus || '',
    store: item.store || item.fulfillmentStore || item.fulfilmentStore || item.branchName || '',
    branchId: item.branchId || item.fulfillmentBranchId || item.fulfilmentBranchId || '',
    createdAt: item.createdAt || item.orderDate || item.created || '',
    updatedAt: item.updatedAt || item.modifiedAt || ''
  };
}

function basicIsOpenStatus(status) {
  const value = String(status || '').toLowerCase();
  return (
    value.includes('pending') ||
    value.includes('accepted') ||
    value.includes('available') ||
    value.includes('offered') ||
    value.includes('open') ||
    value.includes('in behandeling')
  );
}

function basicSummarizeByStore(items = []) {
  const now = Date.now();
  const deadlineMs = 48 * 60 * 60 * 1000;
  const map = new Map();

  for (const item of items) {
    const store = String(item.store || item.branchId || 'Onbekend').trim();
    const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : 0;
    const isOverdue = createdAt && now - createdAt > deadlineMs;

    const row = map.get(store) || {
      store,
      openCount: 0,
      overdueCount: 0,
      overdueRate: 0,
      items: []
    };

    row.openCount += 1;
    if (isOverdue) row.overdueCount += 1;
    row.items.push(item);
    row.overdueRate = row.openCount ? Math.round((row.overdueCount / row.openCount) * 100) : 0;

    map.set(store, row);
  }

  return Array.from(map.values()).sort((a, b) => b.overdueCount - a.overdueCount || b.openCount - a.openCount);
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
    let getSrsOpenWeborders;
    let normalizeWeborder = basicNormalizeWeborder;
    let isOpenWeborderStatus = basicIsOpenStatus;
    let summarizeOverdueByStore = basicSummarizeByStore;

    try {
      const srsClient = await import('../../../lib/srs-open-weborders-client.js');
      const storeHelpers = await import('../../../lib/weborder-request-store.js');

      getSrsOpenWeborders = srsClient.getSrsOpenWeborders;
      normalizeWeborder = storeHelpers.normalizeWeborder || basicNormalizeWeborder;
      isOpenWeborderStatus = storeHelpers.isOpenWeborderStatus || basicIsOpenStatus;
      summarizeOverdueByStore = storeHelpers.summarizeOverdueByStore || basicSummarizeByStore;
    } catch (importError) {
      console.error('[admin/weborders/overdue-report] import error:', importError);

      return res.status(200).json(
        emptyPayload(
          `Openstaande weborders module kon niet worden geladen: ${importError.message || importError}`
        )
      );
    }

    if (typeof getSrsOpenWeborders !== 'function') {
      return res.status(200).json(
        emptyPayload('getSrsOpenWeborders is niet beschikbaar in de SRS client.')
      );
    }

    const result = await getSrsOpenWeborders({});
    const items = (result.items || []).map(normalizeWeborder);
    const openItems = items.filter((item) => isOpenWeborderStatus(item.status));
    const rows = summarizeOverdueByStore(items);
    const overdueItems = rows.flatMap((row) => row.items || []);

    return res.status(200).json({
      success: true,
      source: result.source || 'srs_open_weborders',
      note: result.note || '',
      degraded: Boolean(result.degraded),
      deadlineHours: 48,
      totals: {
        openCount: openItems.length,
        overdueCount: overdueItems.length,
        storeCount: rows.length
      },
      rows
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
