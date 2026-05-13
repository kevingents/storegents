import {
  createVouchersFromLoyaltyPoints,
  getVouchersTransactionStatus,
  getDefaultValidity,
  getLoyaltyVoucherRules
} from '../../../lib/srs-loyalty-vouchers-client-cents.js';
import {
  createLoyaltyVoucherRun,
  updateLoyaltyVoucherRunById,
  getLoyaltyVoucherRuns,
  hasRunForReference
} from '../../../lib/loyalty-voucher-run-store.js';
import { createVoucherLog } from '../../../lib/voucher-log-store.js';
import { resolveVoucherCustomer } from '../../../lib/voucher-customer-resolver.js';
import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

const GENTS_LOYALTY_AMOUNT = '2500';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  if (String(req.query.public || '') === 'true') return true;

  const adminToken = process.env.ADMIN_TOKEN || '12345';

  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  )
    .replace(/^Bearer\s+/i, '')
    .trim();

  return token === adminToken;
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function todayReference(prefix = 'GENTS-loyalty') {
  return `${prefix}-${new Date().toISOString().slice(0, 10)}`;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollExistingTransaction({ transactionId, reference, request, runId }) {
  const attempts = Number(process.env.LOYALTY_VOUCHER_POLL_ATTEMPTS || 4);
  const delayMs = Number(process.env.LOYALTY_VOUCHER_POLL_DELAY_MS || 2500);
  let latest = {
    transactionId,
    reference,
    request,
    status: 'processing',
    vouchers: []
  };

  for (let i = 0; i < attempts; i += 1) {
    await sleep(delayMs);
    latest = await getVouchersTransactionStatus(transactionId);
    latest = {
      ...latest,
      transactionId: latest.transactionId || transactionId,
      reference,
      request
    };

    await updateLoyaltyVoucherRunById(runId, {
      transactionId: latest.transactionId,
      status: latest.status,
      voucherCount: latest.vouchers?.length || 0,
      vouchers: latest.vouchers || []
    });

    if (latest.status === 'completed') return latest;
  }

  return latest;
}

async function logAndMailVouchers({ result, employeeName, sendEmail }) {
  const mailStatus = {};
  const enrichedVouchers = [];

  for (const voucher of result.vouchers || []) {
    const customer = await resolveVoucherCustomer(voucher.customerId);
    let mailResult = null;
    let mailError = '';

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
          shopifyEnabled: false,
          note: 'Deze voucher is automatisch aangemaakt op basis van je gespaarde punten.'
        });
      } catch (error) {
        mailError = error.message || 'Voucher e-mail kon niet worden verstuurd.';
      }
    }

    const status = !customer.customerEmail
      ? 'Automatisch aangemaakt, e-mail ontbreekt'
      : mailError
        ? 'Automatisch aangemaakt, mail mislukt'
        : 'Automatisch aangemaakt en gemaild';

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
      shopifyEnabled: false,
      shopifyGiftCardId: '',
      shopifyGiftCardLastCharacters: '',
      shopifyCustomerId: '',
      note: 'Automatisch tegen SRS loyalty points gegenereerd. GENTS-regel: 500 punten = EUR 25 voucher. Alleen SRS voucher, geen Shopify giftcard.',
      status,
      error: mailError
    });

    mailStatus[voucher.voucherCode] = {
      customerId: voucher.customerId,
      customerEmail: customer.customerEmail,
      mailed: Boolean(mailResult),
      shopifyEnabled: false,
      mailError
    };

    enrichedVouchers.push({
      ...voucher,
      customerEmail: customer.customerEmail,
      customerName: customer.customerName,
      mailed: Boolean(mailResult),
      shopifyEnabled: false,
      mailError,
      shopifyError: ''
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
    const baseRules = getLoyaltyVoucherRules();
    const rules = { ...baseRules, stepsOf: GENTS_LOYALTY_AMOUNT, minimum: GENTS_LOYALTY_AMOUNT, maximum: GENTS_LOYALTY_AMOUNT };
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
  const sendEmail = body.sendEmail !== false;
  const allowDuplicateReference = Boolean(body.allowDuplicateReference);

  const validity = getDefaultValidity();

  const request = {
    reference,
    validFrom: field(body.validFrom).trim() || validity.validFrom,
    validTo: field(body.validTo).trim() || validity.validTo,
    stepsOf: GENTS_LOYALTY_AMOUNT,
    minimum: GENTS_LOYALTY_AMOUNT,
    maximum: GENTS_LOYALTY_AMOUNT,
    displayAmount: 25,
    customerIds,
    sendEmail,
    makeAvailableInShopify: false
  };

  let run = null;

  try {
    const runs = await getLoyaltyVoucherRuns();

    if (!allowDuplicateReference && hasRunForReference(runs, reference)) {
      return res.status(409).json({
        success: false,
        message: `Er bestaat al een loyalty voucher-run voor referentie ${reference}. Gebruik geen tweede run met dezelfde referentie, want SRS kan punten dan opnieuw omzetten.`
      });
    }

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        message: 'Dry-run: er zijn nog geen vouchers aangemaakt. GENTS-regel staat op 500 punten = EUR 25 voucher.',
        request
      });
    }

    const created = await createVouchersFromLoyaltyPoints(request);

    run = await createLoyaltyVoucherRun({
      transactionId: created.transactionId,
      reference,
      status: created.status || 'processing',
      request,
      voucherCount: created.vouchers?.length || 0,
      vouchers: created.vouchers || [],
      mailStatus: {}
    });

    const result = created.status === 'completed'
      ? created
      : await pollExistingTransaction({
          transactionId: created.transactionId,
          reference,
          request,
          runId: run.id
        });

    let mailData = {
      mailStatus: {},
      enrichedVouchers: result.vouchers || []
    };

    if (result.status === 'completed') {
      mailData = await logAndMailVouchers({
        result,
        employeeName,
        sendEmail
      });
    }

    const finalRunData = {
      ...run,
      transactionId: result.transactionId || created.transactionId,
      status: result.status,
      request,
      voucherCount: result.vouchers?.length || 0,
      vouchers: mailData.enrichedVouchers,
      mailStatus: mailData.mailStatus,
      updatedAt: new Date().toISOString()
    };

    run = await updateLoyaltyVoucherRunById(run.id, finalRunData) || finalRunData;

    return res.status(200).json({
      success: true,
      message: result.status === 'completed'
        ? `Run voltooid. ${result.vouchers?.length || 0} vouchers aangemaakt.`
        : `Run gestart met status ${result.status}. Controleer later de status.`,
      run
    });
  } catch (error) {
    console.error('Loyalty voucher run error:', error);

    if (run?.id) {
      const failedRunData = {
        ...run,
        status: 'failed_after_create',
        error: error.message || 'Loyalty voucher-run mislukt na SRS create.',
        request,
        updatedAt: new Date().toISOString()
      };
      run = await updateLoyaltyVoucherRunById(run.id, failedRunData) || failedRunData;
    } else {
      run = await createLoyaltyVoucherRun({
        transactionId: '',
        reference,
        status: 'failed',
        request,
        voucherCount: 0,
        vouchers: [],
        error: error.message || 'Loyalty voucher-run mislukt.'
      });
    }

    return res.status(error.status || 500).json({
      success: false,
      message: run?.status === 'failed_after_create'
        ? `${error.message || 'Loyalty voucher-run mislukt.'} Let op: SRS CreateFromLoyaltyPoints was al gestart; draai niet opnieuw met dezelfde referentie.`
        : error.message || 'Loyalty voucher-run mislukt.',
      run,
      details: error.fault || null
    });
  }
}
