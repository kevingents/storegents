function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function emptySummary(store) {
  return {
    store,
    sellingOpenCount: 0,
    fulfilmentOpenCount: 0,
    overdueCount: 0,
    totalOpenCount: 0,
    sellingOpen: [],
    fulfilmentOpen: [],
    overdue: []
  };
}

function normalizeStore(value) {
  return String(value || '').trim();
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  }

  const store = normalizeStore(req.query.store);
  const branchId = String(req.query.branchId || '').trim();

  try {
    const client = await import('../../lib/srs-open-weborders-client.js');
    const weborders = await import('../../lib/weborder-request-store.js');
    const branches = await import('../../lib/branch-metrics.js');

    const resolvedBranchId = branchId || String(branches.getBranchIdByStore?.(store) || '').trim();
    const result = await client.getSrsOpenWeborders({ store, branchId: resolvedBranchId });
    const items = (result.items || []).map((item) => weborders.normalizeWeborder(item));
    const summary = store ? weborders.summarizeOpenWeborders(items, store) : null;

    return res.status(200).json({
      success: true,
      source: result.source || 'srs_open_weborders',
      note: result.note || '',
      degraded: Boolean(result.degraded),
      store,
      branchId: resolvedBranchId,
      deadlineHours: 48,
      summary: summary || emptySummary(store),
      open: summary?.totalOpenCount || 0,
      overdue: summary?.overdueCount || 0,
      requests: store ? items.filter((item) => item.sellingStore === store || item.fulfilmentStore === store || item.fulfillmentStore === store).slice(0, 200) : items.slice(0, 500)
    });
  } catch (error) {
    console.error('SRS open weborders safe fallback:', error);
    return res.status(200).json({
      success: true,
      degraded: true,
      source: 'safe_empty_fallback',
      note: error.message || 'Open weborders konden niet worden opgehaald. Lege fallback gebruikt zodat het winkelportaal blijft laden.',
      store,
      branchId,
      deadlineHours: 48,
      summary: emptySummary(store),
      open: 0,
      overdue: 0,
      requests: []
    });
  }
}
