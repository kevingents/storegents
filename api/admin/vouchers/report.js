import { getVoucherLogs } from '../../../lib/voucher-log-store.js';
import { getClosedVouchers } from '../../../lib/srs-vouchers-client.js';
import { getStoreNameByBranchId } from '../../../lib/srs-branch-names.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date.toISOString().slice(0, 10);
}

function formatAmount(value) {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function getVoucherUseStatus(log, closedMatch) {
  if (log.status === 'afgeboekt_in_srs') {
    return {
      status: 'Gebruikt online',
      statusKey: 'used_online',
      usedStore: getStoreNameByBranchId(log.srsRedeemBranchId),
      usedBranchId: log.srsRedeemBranchId || '',
      usedReceiptNumber: log.shopifyOrderName || log.shopifyOrderId || '',
      usedAt: log.srsRedeemedAt || log.updatedAt || ''
    };
  }

  if (log.status === 'gebruikt_in_winkel_shopify_gedeactiveerd' || log.status === 'gebruikt_in_winkel_geen_shopify') {
    return {
      status: log.status === 'gebruikt_in_winkel_shopify_gedeactiveerd' ? 'Gebruikt in winkel, Shopify gedeactiveerd' : 'Gebruikt in winkel',
      statusKey: 'used_store',
      usedStore: log.usedStore || getStoreNameByBranchId(log.srsRedeemBranchId),
      usedBranchId: log.srsRedeemBranchId || '',
      usedReceiptNumber: log.srsReceiptNumber || '',
      usedAt: log.srsRedeemedAt || log.updatedAt || ''
    };
  }

  if (log.status === 'shopify_giftcard_deactiveren_mislukt') {
    return {
      status: 'Gebruikt in winkel, Shopify deactiveren mislukt',
      statusKey: 'shopify_deactivate_failed',
      usedStore: log.usedStore || getStoreNameByBranchId(log.srsRedeemBranchId),
      usedBranchId: log.srsRedeemBranchId || '',
      usedReceiptNumber: log.srsReceiptNumber || '',
      usedAt: log.srsRedeemedAt || log.updatedAt || ''
    };
  }

  if (log.status === 'srs_afboeken_mislukt') {
    return {
      status: 'Shopify gebruikt, SRS mislukt',
      statusKey: 'srs_failed',
      usedStore: 'Webshop',
      usedBranchId: process.env.SRS_WEBSHOP_BRANCH_ID || '',
      usedReceiptNumber: log.shopifyOrderName || log.shopifyOrderId || '',
      usedAt: log.updatedAt || ''
    };
  }

  if (closedMatch) {
    return {
      status: 'Gebruikt in winkel',
      statusKey: 'used_store',
      usedStore: getStoreNameByBranchId(closedMatch.branchId),
      usedBranchId: closedMatch.branchId || '',
      usedReceiptNumber: closedMatch.receiptNumber || '',
      usedAt: ''
    };
  }

  return {
    status: 'Open',
    statusKey: 'open',
    usedStore: '',
    usedBranchId: '',
    usedReceiptNumber: '',
    usedAt: ''
  };
}

function buildSummary(rows) {
  const summaryMap = new Map();

  rows.forEach((row) => {
    const key = row.usedStore || 'Open / niet gebruikt';
    const existing = summaryMap.get(key) || {
      store: key,
      totalVouchers: 0,
      totalAmount: 0,
      usedOnline: 0,
      usedStore: 0,
      open: 0,
      failed: 0,
      shopifyDeactivateFailed: 0
    };

    existing.totalVouchers += 1;
    existing.totalAmount += formatAmount(row.amount);

    if (row.statusKey === 'used_online') existing.usedOnline += 1;
    else if (row.statusKey === 'used_store') existing.usedStore += 1;
    else if (row.statusKey === 'srs_failed' || row.statusKey === 'shopify_deactivate_failed') existing.failed += 1;
    else existing.open += 1;

    summaryMap.set(key, existing);
  });

  return Array.from(summaryMap.values())
    .map((item) => ({
      ...item,
      totalAmount: formatAmount(item.totalAmount)
    }))
    .sort((a, b) => {
      if (a.store === 'Open / niet gebruikt') return 1;
      if (b.store === 'Open / niet gebruikt') return -1;
      return a.store.localeCompare(b.store);
    });
}

function buildRows(logs, closed) {
  const closedMap = new Map();

  closed.forEach((item) => {
    if (item.barcode && !closedMap.has(item.barcode)) {
      closedMap.set(item.barcode, item);
    }
  });

  const rows = logs.map((log) => {
    const closedMatch = closedMap.get(log.voucherCode);
    const use = getVoucherUseStatus(log, closedMatch);

    return {
      id: log.id,
      createdAt: log.createdAt || '',
      voucherCode: log.voucherCode || '',
      customerName: log.customerName || '',
      customerEmail: log.customerEmail || '',
      srsCustomerId: log.srsCustomerId || '',
      amount: formatAmount(log.amount),
      currency: log.currency || 'EUR',
      validFrom: log.validFrom || '',
      validTo: log.validTo || '',
      status: use.status,
      statusKey: use.statusKey,
      usedStore: use.usedStore,
      usedBranchId: use.usedBranchId,
      usedReceiptNumber: use.usedReceiptNumber,
      usedAt: use.usedAt,
      shopifyGiftCardId: log.shopifyGiftCardId || '',
      shopifyOrderName: log.shopifyOrderName || '',
      error: log.error || ''
    };
  });

  const loggedCodes = new Set(logs.map((log) => log.voucherCode).filter(Boolean));

  closed.forEach((item) => {
    if (!item.barcode || loggedCodes.has(item.barcode)) {
      return;
    }

    rows.push({
      id: `srs-${item.barcode}`,
      createdAt: '',
      voucherCode: item.barcode,
      customerName: '',
      customerEmail: '',
      srsCustomerId: '',
      amount: 0,
      currency: 'EUR',
      validFrom: '',
      validTo: '',
      status: 'Gebruikt in winkel (niet via portaal aangemaakt)',
      statusKey: 'used_store',
      usedStore: getStoreNameByBranchId(item.branchId),
      usedBranchId: item.branchId || '',
      usedReceiptNumber: item.receiptNumber || '',
      usedAt: '',
      shopifyGiftCardId: '',
      shopifyOrderName: '',
      error: ''
    });
  });

  return rows;
}

export default async function handler(req, res) {
  if (String(process.env.DISABLE_ADMIN_REPORTS || '').toLowerCase() === 'true' && String(req.query.force || '') !== 'true') {
    return res.status(200).json({
      success: true,
      disabled: true,
      message: 'Admin rapportages zijn tijdelijk uitgeschakeld om SRS/server te ontlasten.',
      rows: [],
      totals: { total: 0, open: 0, used: 0, openCount: 0, overdueCount: 0, storeCount: 0 }
    });
  }

  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const dateFrom = String(req.query.dateFrom || req.query.from || daysAgoIso(90)).trim();
    const dateTo = String(req.query.dateTo || req.query.to || todayIso()).trim();
    const includeSrsClosed = String(req.query.includeSrsClosed || 'true') !== 'false';

    const logs = await getVoucherLogs();
    let closed = [];
    let srsClosedError = '';

    if (includeSrsClosed) {
      try {
        const closedResult = await getClosedVouchers({
          dateFrom,
          dateTo
        });

        closed = closedResult.closed || [];
      } catch (error) {
        srsClosedError = error.message || 'SRS gesloten vouchers konden niet worden opgehaald.';
      }
    }

    const rows = buildRows(logs, closed);
    const filteredRows = rows.filter((row) => {
      if (!dateFrom && !dateTo) return true;

      const dateValue = row.createdAt || row.usedAt || '';

      if (!dateValue) return true;

      const dateOnly = dateValue.slice(0, 10);

      if (dateFrom && dateOnly < dateFrom) return false;
      if (dateTo && dateOnly > dateTo) return false;

      return true;
    });

    const totals = {
      totalVouchers: filteredRows.length,
      totalAmount: formatAmount(filteredRows.reduce((sum, row) => sum + Number(row.amount || 0), 0)),
      usedOnline: filteredRows.filter((row) => row.statusKey === 'used_online').length,
      usedStore: filteredRows.filter((row) => row.statusKey === 'used_store').length,
      open: filteredRows.filter((row) => row.statusKey === 'open').length,
      failed: filteredRows.filter((row) => row.statusKey === 'srs_failed' || row.statusKey === 'shopify_deactivate_failed').length
    };

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      totals,
      summary: buildSummary(filteredRows),
      rows: filteredRows,
      srsClosedCount: closed.length,
      srsClosedError
    });
  } catch (error) {
    console.error('Admin voucher report error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Voucherrapportage kon niet worden opgehaald.'
    });
  }
}
