import { getVoucherLogs, updateVoucherLogById } from '../../../lib/voucher-log-store.js';
import { getClosedVouchers } from '../../../lib/srs-vouchers-client.js';
import { deactivateShopifyGiftCard } from '../../../lib/shopify-gift-card-client.js';
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

function isAlreadyFinal(log) {
  return [
    'afgeboekt_in_srs',
    'gebruikt_in_winkel_shopify_gedeactiveerd',
    'gebruikt_in_winkel_geen_shopify',
    'shopify_giftcard_gedeactiveerd'
  ].includes(log.status);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Alleen POST is toegestaan.'
    });
  }

  try {
    const body = req.body || {};
    const dateFrom = String(body.dateFrom || body.from || daysAgoIso(90)).trim();
    const dateTo = String(body.dateTo || body.to || todayIso()).trim();

    const closedResult = await getClosedVouchers({ dateFrom, dateTo });
    const closed = closedResult.closed || [];
    const logs = await getVoucherLogs();

    const closedByBarcode = new Map();
    closed.forEach((item) => {
      if (item.barcode && !closedByBarcode.has(item.barcode)) {
        closedByBarcode.set(item.barcode, item);
      }
    });

    const results = [];

    for (const log of logs) {
      if (!log.voucherCode) continue;

      const closedMatch = closedByBarcode.get(log.voucherCode);
      if (!closedMatch) continue;

      if (isAlreadyFinal(log)) {
        results.push({
          voucherCode: log.voucherCode,
          skipped: true,
          reason: `Status is al ${log.status}`,
          usedStore: getStoreNameByBranchId(closedMatch.branchId),
          receiptNumber: closedMatch.receiptNumber
        });
        continue;
      }

      const usedStore = getStoreNameByBranchId(closedMatch.branchId);
      const baseUpdates = {
        usedStore,
        srsRedeemBranchId: closedMatch.branchId || '',
        srsReceiptNumber: closedMatch.receiptNumber || '',
        srsRedeemedAt: new Date().toISOString(),
        shopifyOrderId: log.shopifyOrderId || '',
        shopifyOrderName: log.shopifyOrderName || ''
      };

      if (!log.shopifyGiftCardId) {
        const updated = await updateVoucherLogById(log.id, {
          ...baseUpdates,
          status: 'gebruikt_in_winkel_geen_shopify',
          error: ''
        });

        results.push({
          voucherCode: log.voucherCode,
          usedStore,
          receiptNumber: closedMatch.receiptNumber,
          shopifyGiftCardId: '',
          deactivated: false,
          message: 'Voucher is in SRS gebruikt. Geen Shopify gift card gekoppeld.',
          updated
        });

        continue;
      }

      try {
        const giftCard = await deactivateShopifyGiftCard(log.shopifyGiftCardId);

        const updated = await updateVoucherLogById(log.id, {
          ...baseUpdates,
          status: 'gebruikt_in_winkel_shopify_gedeactiveerd',
          shopifyGiftCardDeactivatedAt: giftCard?.deactivatedAt || new Date().toISOString(),
          error: ''
        });

        results.push({
          voucherCode: log.voucherCode,
          usedStore,
          receiptNumber: closedMatch.receiptNumber,
          shopifyGiftCardId: log.shopifyGiftCardId,
          deactivated: true,
          giftCard,
          updated
        });
      } catch (error) {
        const updated = await updateVoucherLogById(log.id, {
          ...baseUpdates,
          status: 'shopify_giftcard_deactiveren_mislukt',
          error: error.message || 'Shopify gift card deactiveren mislukt.'
        });

        results.push({
          voucherCode: log.voucherCode,
          usedStore,
          receiptNumber: closedMatch.receiptNumber,
          shopifyGiftCardId: log.shopifyGiftCardId,
          deactivated: false,
          error: error.message,
          updated
        });
      }
    }

    return res.status(200).json({
      success: true,
      dateFrom,
      dateTo,
      srsClosedCount: closed.length,
      processedCount: results.length,
      deactivatedCount: results.filter((item) => item.deactivated).length,
      failedCount: results.filter((item) => item.error).length,
      results
    });
  } catch (error) {
    console.error('Sync SRS closed vouchers error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'SRS gebruikte vouchers konden niet worden gesynchroniseerd.'
    });
  }
}
