import { makeVoucher, checkVoucher } from '../../lib/srs-vouchers-client.js';
import { createShopifyGiftCard } from '../../lib/shopify-gift-card-client.js';
import { sendVoucherEmail } from '../../lib/voucher-mailer.js';
import { createVoucherLog } from '../../lib/voucher-log-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });

  const body = req.body || {};
  const store = field(body.store).trim();
  const employeeName = field(body.employeeName).trim();
  const customerName = field(body.customerName).trim();
  const customerEmail = field(body.customerEmail).trim();
  const srsCustomerId = field(body.srsCustomerId).trim();
  const voucherGroupId = field(body.voucherGroupId).trim();
  const validFrom = field(body.validFrom).trim();
  const validTo = field(body.validTo).trim();
  const note = field(body.note).trim();
  const makeAvailableInShopify = Boolean(body.makeAvailableInShopify);
  const sendEmail = body.sendEmail !== false;

  try {
    if (!store || !employeeName || !customerEmail || !srsCustomerId || !voucherGroupId || !validFrom || !validTo) {
      return res.status(400).json({ success: false, message: 'Vul winkel, medewerker, klant e-mail, SRS klant ID, vouchergroep en geldigheid in.' });
    }

    const created = await makeVoucher({ voucherType: voucherGroupId, customerId: srsCustomerId, validFrom, validTo });
    const checked = await checkVoucher({ barcode: created.barcode });

    let shopifyResult = null;
    let shopifyError = '';

    if (makeAvailableInShopify) {
      try {
        shopifyResult = await createShopifyGiftCard({
          code: created.barcode,
          amount: checked.amount,
          currencyCode: checked.currency || 'EUR',
          expiresOn: validTo,
          note: `SRS voucher ${created.barcode} voor klant ${srsCustomerId}. Aangemaakt door ${employeeName} (${store}).`,
          customerEmail
        });
      } catch (error) {
        shopifyError = error.message || 'Shopify gift card kon niet worden aangemaakt.';
      }
    }

    let mailResult = null;

    if (sendEmail) {
      mailResult = await sendVoucherEmail({
        to: customerEmail,
        customerName,
        voucherCode: created.barcode,
        amount: checked.amount,
        currency: checked.currency || 'EUR',
        validFrom,
        validTo,
        shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
        note
      });
    }

    const log = await createVoucherLog({
      store, employeeName, customerName, customerEmail, srsCustomerId, voucherGroupId,
      voucherCode: created.barcode,
      amount: checked.amount,
      currency: checked.currency || 'EUR',
      validFrom,
      validTo,
      mailed: Boolean(mailResult),
      shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
      shopifyGiftCardId: shopifyResult?.giftCard?.id || '',
      shopifyGiftCardLastCharacters: shopifyResult?.giftCard?.lastCharacters || '',
      shopifyCustomerId: shopifyResult?.customer?.id || '',
      note,
      status: shopifyError ? 'SRS aangemaakt, mail verzonden, Shopify mislukt' : 'Aangemaakt',
      error: shopifyError
    });

    return res.status(200).json({
      success: true,
      message: shopifyError ? 'Voucher is aangemaakt en gemaild. Shopify gift card kon niet worden aangemaakt.' : 'Voucher is aangemaakt en gemaild.',
      voucher: { code: created.barcode, amount: checked.amount, currency: checked.currency || 'EUR', validFrom, validTo, srsCustomerId, info: checked.info, status: checked.status },
      shopify: shopifyResult,
      shopifyError,
      log
    });
  } catch (error) {
    console.error('Create and mail voucher error:', error);
    await createVoucherLog({ store, employeeName, customerName, customerEmail, srsCustomerId, voucherGroupId, validFrom, validTo, mailed: false, shopifyEnabled: false, note, status: 'Mislukt', error: error.message || 'Voucher aanmaken mislukt.' });
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Voucher kon niet worden aangemaakt.', details: error.fault || null });
  }
}
