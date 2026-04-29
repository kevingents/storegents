import {
  createAndPollVouchersFromLoyaltyPoints,
  getVouchersTransactionStatus,
  getDefaultValidity,
  getLoyaltyVoucherRules
} from '../../../lib/srs-loyalty-vouchers-client.js';
import {
  createLoyaltyVoucherRun,
  updateLoyaltyVoucherRun,
  getLoyaltyVoucherRuns,
  hasRunForReference
} from '../../../lib/loyalty-voucher-run-store.js';
import { createVoucherLog } from '../../../lib/voucher-log-store.js';
import { resolveVoucherCustomer } from '../../../lib/voucher-customer-resolver.js';
import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { createShopifyGiftCard } from '../../../lib/shopify-gift-card-client.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function todayReference(prefix = 'GENTS-loyalty') {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}`;
}

async function logAndMailVouchers({ result, employeeName, makeAvailableInShopify, sendEmail }) {
  const mailStatus = {};
  const enrichedVouchers = [];

  for (const voucher of result.vouchers || []) {
    const customer = await resolveVoucherCustomer(voucher.customerId);
    let shopifyResult = null;
    let shopifyError = '';
    let mailResult = null;
    let mailError = '';

    if (makeAvailableInShopify && customer.customerEmail) {
      try {
        shopifyResult = await createShopifyGiftCard({
          code: voucher.voucherCode,
          amount: voucher.value,
          currencyCode: 'EUR',
          expiresOn: voucher.validTo,
          note: `Automatische loyalty voucher ${voucher.voucherCode} voor SRS klant ${voucher.customerId}.`,
          customerEmail: customer.customerEmail
        });
      } catch (error) {
        shopifyError = error.message || 'Shopify gift card kon niet worden aangemaakt.';
      }
    }

    if (sendEmail && customer.customerEmail) {
      try {
        mailResult = await sendVoucherEmail({
          to: customer.customerEmail,
          customerName: customer.customerName,
          voucherCode: voucher.voucherCode,
          amount: voucher.value,
          currency: 'EUR',
          validFrom: voucher.validFrom,
          validTo: voucher.validTo,
          shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
          note: 'Deze voucher is automatisch aangemaakt op basis van je gespaarde punten.'
        });
      } catch (error) {
        mailError = error.message || 'Voucher e-mail kon niet worden verstuurd.';
      }
    }

    const status = !customer.customerEmail
      ? 'Automatisch aangemaakt, e-mail ontbreekt'
      : shopifyError
        ? 'Automatisch aangemaakt, Shopify mislukt'
        : mailError
          ? 'Automatisch aangemaakt, mail mislukt'
          : 'Automatisch aangemaakt';

    await createVoucherLog({
      store: 'GENTS Administratie',
      employeeName,
      customerName: customer.customerName,
      customerEmail: customer.customerEmail,
      srsCustomerId: voucher.customerId,
      voucherGroupId: 'CreateFromLoyaltyPoints',
      voucherCode: voucher.voucherCode,
      amount: voucher.value,
      currency: 'EUR',
      validFrom: voucher.validFrom,
      validTo: voucher.validTo,
      mailed: Boolean(mailResult),
      shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
      shopifyGiftCardId: shopifyResult?.giftCard?.id || '',
      shopifyGiftCardLastCharacters: shopifyResult?.giftCard?.lastCharacters || '',
      shopifyCustomerId: shopifyResult?.customer?.id || '',
      note: 'Automatisch gegenereerd vanuit SRS loyalty points.',
      status,
      error: shopifyError || mailError
    });

    mailStatus[voucher.voucherCode] = {
      customerId: voucher.customerId,
      customerEmail: customer.customerEmail,
      mailed: Boolean(mailResult),
      shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
      shopifyError,
      mailError
    };

    enrichedVouchers.push({
      ...voucher,
      customerEmail: customer.customerEmail,
      customerName: customer.customerName,
      mailed: Boolean(mailResult),
      shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
      shopifyError,
      mailError
    });
  }

  return { mailStatus, enrichedVouchers };
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);

  if (req.method === 'GET') {
    if (!isAuthorized(req)) {
      return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
    }

    const runs = await getLoyaltyVoucherRuns();
    const rules = getLoyaltyVoucherRules();
    const validity = getDefaultValidity();

    return res.status(200).json({
      success: true,
      rules,
      validity,
      runs: runs.slice(0, 25)
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const body = req.body || {};
  const dryRun = Boolean(body.dryRun);
  const employeeName = field(body.employeeName).trim() || 'Automatische voucher-run';
  const reference = field(body.reference).trim() || todayReference();
  const customerIds = Array.isArray(body.customerIds) ? body.customerIds.map(String).filter(Boolean) : [];
  const makeAvailableInShopify = Boolean(body.makeAvailableInShopify);
  const sendEmail = body.sendEmail !== false;
  const allowDuplicateReference = Boolean(body.allowDuplicateReference);

  const rules = getLoyaltyVoucherRules();
  const validity = getDefaultValidity();

  const request = {
    reference,
    validFrom: field(body.validFrom).trim() || validity.validFrom,
    validTo: field(body.validTo).trim() || validity.validTo,
    stepsOf: field(body.stepsOf).trim() || rules.stepsOf,
    minimum: field(body.minimum).trim() || rules.minimum,
    maximum: field(body.maximum).trim() || rules.maximum,
    customerIds
  };

  try {
    const runs = await getLoyaltyVoucherRuns();

    if (!allowDuplicateReference && hasRunForReference(runs, reference)) {
      return res.status(409).json({
        success: false,
        message: `Er bestaat al een loyalty voucher-run voor referentie ${reference}.`
      });
    }

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        message: 'Dry-run: er zijn nog geen vouchers aangemaakt. Let op: SRS heeft geen echte preview zonder CreateFromLoyaltyPoints uit te voeren.',
        request
      });
    }

    const result = await createAndPollVouchersFromLoyaltyPoints(request);

    let mailData = {
      mailStatus: {},
      enrichedVouchers: result.vouchers || []
    };

    if (result.status === 'completed') {
      mailData = await logAndMailVouchers({
        result,
        employeeName,
        makeAvailableInShopify,
        sendEmail
      });
    }

    const run = await createLoyaltyVoucherRun({
      transactionId: result.transactionId,
      reference,
      status: result.status,
      request,
      voucherCount: result.vouchers?.length || 0,
      vouchers: mailData.enrichedVouchers,
      mailStatus: mailData.mailStatus
    });

    return res.status(200).json({
      success: true,
      message: result.status === 'completed'
        ? `Run voltooid. ${result.vouchers?.length || 0} vouchers aangemaakt.`
        : `Run gestart met status ${result.status}. Controleer later de status.`,
      run
    });
  } catch (error) {
    console.error('Loyalty voucher run error:', error);

    const run = await createLoyaltyVoucherRun({
      transactionId: '',
      reference,
      status: 'failed',
      request,
      voucherCount: 0,
      vouchers: [],
      error: error.message || 'Loyalty voucher-run mislukt.'
    });

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Loyalty voucher-run mislukt.',
      run,
      details: error.fault || null
    });
  }
}
