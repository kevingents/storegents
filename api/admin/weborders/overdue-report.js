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
      normalizeWeborder: helpers.normalizeWeborder,
      isOpenWeborderStatus: helpers.isOpenWeborderStatus,
      summarizeOverdueByStore: helpers.summarizeOverdueByStore
    };
  } catch (error) {
    console.error('[admin/weborders/overdue-report] helper import failed:', error);
    throw error;
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
    const rows = summarizeOverdueByStore(items);
    const overdueCount = rows.reduce(
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
