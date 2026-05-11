import {
  checkVoucher,
  getVoucherLock,
  cancelVoucherLock,
  boekVoucherExtern,
  loginSrsVoucherService
} from '../../lib/srs-vouchers-client.js';
import {
  createShopifyGiftCard,
  deactivateShopifyGiftCard
} from '../../lib/shopify-gift-card-client.js';
import { createVoucherLog } from '../../lib/voucher-log-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function isVoucherUsable(voucher) {
  const status = String(voucher.status || '').toLowerCase();
  const amount = Number(voucher.amount || 0);

  return amount > 0 && !['inactive', 'nonactive', 'closed', 'used', 'cancelled', 'gebruikt'].includes(status);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });
  }

  const body = req.body || {};
  const barcode = field(body.barcode).trim();
  const customerEmail = field(body.customerEmail).trim();
  const customerName = field(body.customerName).trim();
  const branchId = field(body.branchId).trim() || process.env.SRS_WEBSHOP_BRANCH_ID || process.env.SRS_BRANCH_ID || '';
  const timeoutSecs = Number(process.env.SRS_VOUCHER_LOCK_TIMEOUT_SECS || 600);

  let sessionId = '';
  let voucherLockId = '';
  let shopifyResult = null;

  try {
    if (!barcode || !customerEmail) {
      return res.status(400).json({
        success: false,
        message: 'Vouchercode en e-mailadres zijn verplicht.'
      });
    }

    if (!branchId) {
      return res.status(500).json({
        success: false,
        message: 'SRS_WEBSHOP_BRANCH_ID ontbreekt.'
      });
    }

    sessionId = await loginSrsVoucherService();

    const voucher = await checkVoucher({ barcode, sessionId });

    if (!isVoucherUsable(voucher)) {
      return res.status(400).json({
        success: false,
        message: 'Deze voucher is niet geldig of heeft geen saldo.',
        voucher
      });
    }

    const lock = await getVoucherLock({ barcode, timeoutSecs, sessionId });
    voucherLockId = lock.voucherLockId;

    try {
      shopifyResult = await createShopifyGiftCard({
        code: barcode,
        amount: voucher.amount,
        currencyCode: voucher.currency || 'EUR',
        expiresOn: body.validTo || undefined,
        customerEmail,
        note: `SRS voucher ${barcode} omgezet naar Shopify giftcard voor ${customerEmail}.`
      });
    } catch (shopifyError) {
      await cancelVoucherLock({ barcode, voucherLockId, sessionId });

      return res.status(502).json({
        success: false,
        message: shopifyError.message || 'Shopify giftcard kon niet worden aangemaakt.'
      });
    }

    const redeemed = await boekVoucherExtern({
      barcode,
      voucherLockId,
      branchId,
      sessionId
    });

    if (!redeemed.success) {
      if (shopifyResult?.giftCard?.id) {
        await deactivateShopifyGiftCard(shopifyResult.giftCard.id);
      }

      throw new Error('SRS voucher kon niet non-actief worden gezet. Shopify giftcard is gedeactiveerd.');
    }

    const log = await createVoucherLog({
      store: 'Shopify',
      employeeName: 'Shopify voucher inruilpagina',
      customerName,
      customerEmail,
      srsCustomerId: voucher.customerId || '',
      voucherGroupId: 'SRS-to-Shopify-giftcard',
      voucherCode: barcode,
      amount: voucher.amount,
      currency: voucher.currency || 'EUR',
      validFrom: '',
      validTo: body.validTo || '',
      mailed: false,
      shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
      shopifyGiftCardId: shopifyResult?.giftCard?.id || '',
      shopifyGiftCardLastCharacters: shopifyResult?.giftCard?.lastCharacters || '',
      shopifyCustomerId: shopifyResult?.customer?.id || '',
      note: 'SRS voucher ingewisseld naar Shopify digitale giftcard.',
      status: 'Ingewisseld naar Shopify giftcard',
      error: ''
    });

    return res.status(200).json({
      success: true,
      message: 'Voucher is ingewisseld voor een digitale giftcard.',
      voucher: {
        code: barcode,
        amount: voucher.amount,
        currency: voucher.currency || 'EUR',
        srsRedeemed: true
      },
      shopify: shopifyResult,
      log
    });
  } catch (error) {
    if (voucherLockId) {
      try {
        await cancelVoucherLock({ barcode, voucherLockId, sessionId });
      } catch (_) {}
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Voucher kon niet worden ingewisseld.',
      details: error.fault || null
    });
  }
}
