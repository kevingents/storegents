import { readRawBody, verifyShopifyWebhook } from '../../../lib/shopify-webhook-verify.js';
import { extractGiftCardUsages } from '../../../lib/shopify-order-giftcards.js';
import {
  getVoucherLogs,
  updateVoucherLogById,
  findVoucherLogForShopifyGiftCard
} from '../../../lib/voucher-log-store.js';
import { redeemVoucherForWebshop } from '../../../lib/srs-vouchers-client.js';

export const config = {
  api: {
    bodyParser: false
  }
};

function getWebshopBranchId() {
  const branchId = process.env.SRS_WEBSHOP_BRANCH_ID || '';

  if (!branchId) {
    throw new Error('SRS_WEBSHOP_BRANCH_ID ontbreekt. Vraag SRS welk filiaalId voor webshop voucherafboeking gebruikt moet worden.');
  }

  return branchId;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Alleen POST is toegestaan.'
    });
  }

  const rawBody = await readRawBody(req);
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];

  if (!verifyShopifyWebhook(rawBody, hmacHeader)) {
    return res.status(401).json({
      success: false,
      message: 'Ongeldige Shopify webhook signature.'
    });
  }

  let order;

  try {
    order = JSON.parse(rawBody.toString('utf8'));
  } catch (error) {
    return res.status(400).json({
      success: false,
      message: 'Webhook body is geen geldige JSON.'
    });
  }

  try {
    const giftCardUsages = extractGiftCardUsages(order);

    if (!giftCardUsages.length) {
      return res.status(200).json({
        success: true,
        message: 'Geen gift card gebruik gevonden.'
      });
    }

    const branchId = getWebshopBranchId();
    const logs = await getVoucherLogs();
    const results = [];

    for (const usage of giftCardUsages) {
      const log = findVoucherLogForShopifyGiftCard(logs, usage);

      if (!log) {
        results.push({
          matched: false,
          usage,
          message: 'Geen gekoppelde voucherlog gevonden voor gebruikte Shopify gift card.'
        });
        continue;
      }

      if (['afgeboekt_in_srs', 'gebruikt_in_shopify'].includes(log.status)) {
        results.push({
          matched: true,
          voucherCode: log.voucherCode,
          skipped: true,
          message: 'Voucher was al verwerkt.'
        });
        continue;
      }

      try {
        const redeemed = await redeemVoucherForWebshop({
          barcode: log.voucherCode,
          branchId,
          timeoutSecs: 600
        });

        const updated = await updateVoucherLogById(log.id, {
          status: 'afgeboekt_in_srs',
          shopifyOrderId: String(order.id || ''),
          shopifyOrderName: String(order.name || order.order_number || ''),
          srsRedeemedAt: new Date().toISOString(),
          srsRedeemBranchId: String(branchId),
          srsVoucherLockId: redeemed.voucherLockId || '',
          error: ''
        });

        results.push({
          matched: true,
          voucherCode: log.voucherCode,
          redeemed: true,
          updated
        });
      } catch (error) {
        const updated = await updateVoucherLogById(log.id, {
          status: 'srs_afboeken_mislukt',
          shopifyOrderId: String(order.id || ''),
          shopifyOrderName: String(order.name || order.order_number || ''),
          error: error.message || 'SRS voucher afboeken mislukt.'
        });

        results.push({
          matched: true,
          voucherCode: log.voucherCode,
          redeemed: false,
          error: error.message,
          updated
        });
      }
    }

    return res.status(200).json({
      success: true,
      orderId: order.id,
      orderName: order.name || order.order_number,
      results
    });
  } catch (error) {
    console.error('Shopify orders paid webhook error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Webhook kon niet worden verwerkt.'
    });
  }
}
