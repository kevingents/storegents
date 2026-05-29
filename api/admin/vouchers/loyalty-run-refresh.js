import { getVouchersTransactionStatus } from '../../../lib/srs-loyalty-vouchers-client-cents.js';
import { getLoyaltyVoucherRuns, updateLoyaltyVoucherRunById } from '../../../lib/loyalty-voucher-run-store.js';
import { createVoucherLog } from '../../../lib/voucher-log-store.js';
import { resolveVoucherCustomer } from '../../../lib/voucher-customer-resolver.js';
import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()));
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function boolQuery(req, key) {
  return String(req.query[key] || req.body?.[key] || '').toLowerCase() === 'true';
}

function shouldSendEmail(req, run) {
  if (String(req.query.sendEmail || req.body?.sendEmail || '').toLowerCase() === 'false') return false;
  if (boolQuery(req, 'forceEmail')) return true;

  const statuses = Object.values(run?.mailStatus || {});
  if (!statuses.length) return true;

  // Retry mailing when previous status exists but nothing was actually mailed.
  return !statuses.every((item) => item?.mailed === true);
}

function alreadyMailed(run, voucherCode) {
  return Boolean(run?.mailStatus?.[voucherCode]?.mailed);
}

async function logAndMailVouchers({ result, run, sendEmail, forceEmail }) {
  const mailStatus = { ...(run?.mailStatus || {}) };
  const enrichedVouchers = [];
  const employeeName = run?.request?.employeeName || 'Automatische spaarpunten-voucher-cron';

  for (const voucher of result.vouchers || []) {
    const customer = await resolveVoucherCustomer(voucher.customerId);
    let mailResult = null;
    let mailError = '';
    const voucherCode = voucher.voucherCode || voucher.id;
    const wasAlreadyMailed = alreadyMailed(run, voucherCode);

    if (sendEmail && customer.customerEmail && (!wasAlreadyMailed || forceEmail)) {
      try {
        mailResult = await sendVoucherEmail({
          to: customer.customerEmail,
          customerName: customer.customerName,
          voucherCode,
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

    const mailed = wasAlreadyMailed && !forceEmail ? true : Boolean(mailResult);
    const status = !customer.customerEmail
      ? 'Automatisch aangemaakt, e-mail ontbreekt'
      : mailError
        ? 'Automatisch aangemaakt, mail mislukt'
        : mailed
          ? 'Automatisch aangemaakt en gemaild'
          : 'Automatisch aangemaakt, mail overgeslagen';

    await createVoucherLog({
      store: 'GENTS Administratie',
      employeeName,
      customerName: customer.customerName,
      customerEmail: customer.customerEmail,
      srsCustomerId: voucher.customerId,
      voucherGroupId: 'CreateFromLoyaltyPoints',
      voucherCode,
      amount: voucher.value,
      currency: 'EUR',
      validFrom: voucher.validFrom,
      validTo: voucher.validTo,
      mailed,
      shopifyEnabled: false,
      shopifyGiftCardId: '',
      shopifyGiftCardLastCharacters: '',
      shopifyCustomerId: '',
      note: 'Automatisch tegen SRS loyalty points gegenereerd. GENTS-regel: 500 punten = EUR 25 voucher. Alleen SRS voucher, geen Shopify giftcard.',
      status,
      error: mailError
    });

    mailStatus[voucherCode] = {
      customerId: voucher.customerId,
      customerEmail: customer.customerEmail,
      mailed,
      shopifyEnabled: false,
      mailError
    };

    enrichedVouchers.push({
      ...voucher,
      customerEmail: customer.customerEmail,
      customerName: customer.customerName,
      mailed,
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

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const transactionId = String(req.query.transactionId || req.body?.transactionId || '').trim();
  if (!transactionId) {
    return res.status(400).json({ success: false, message: 'TransactionId ontbreekt.' });
  }

  try {
    const runs = await getLoyaltyVoucherRuns();
    const run = runs.find((item) => item.transactionId === transactionId) || null;
    const result = await getVouchersTransactionStatus(transactionId);
    const statusResult = {
      ...result,
      transactionId: result.transactionId || transactionId,
      reference: run?.reference || '',
      request: run?.request || {}
    };

    let updatedRun = run;

    if (run?.id) {
      let mailData = {
        mailStatus: run.mailStatus || {},
        enrichedVouchers: result.vouchers || []
      };

      if (statusResult.status === 'completed') {
        mailData = await logAndMailVouchers({
          result: statusResult,
          run,
          sendEmail: shouldSendEmail(req, run),
          forceEmail: boolQuery(req, 'forceEmail')
        });
      }

      const finalRunData = {
        ...run,
        status: statusResult.status,
        transactionId: statusResult.transactionId,
        voucherCount: statusResult.vouchers?.length || 0,
        vouchers: statusResult.status === 'completed' ? mailData.enrichedVouchers : statusResult.vouchers || [],
        mailStatus: statusResult.status === 'completed' ? mailData.mailStatus : run.mailStatus || {},
        updatedAt: new Date().toISOString()
      };

      updatedRun = await updateLoyaltyVoucherRunById(run.id, finalRunData) || finalRunData;
    }

    return res.status(200).json({
      success: true,
      message: statusResult.status === 'completed'
        ? `Run voltooid. ${statusResult.vouchers?.length || 0} vouchers gevonden.`
        : `Run staat op ${statusResult.status || 'onbekend'}.`,
      status: statusResult,
      run: updatedRun
    });
  } catch (error) {
    console.error('Loyalty run refresh error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Loyalty run status kon niet worden opgehaald.',
      details: error.fault || null
    });
  }
}
