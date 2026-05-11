import {
  loginSrsPointsService,
  getPointsBalance,
  changePoints
} from '../../../lib/srs-points-client.js';
import { getVoucherGroups, makeVoucher, checkVoucher } from '../../../lib/srs-vouchers-client.js';
import { findShopifyCustomerBySrsCustomerId, updateShopifyCustomerMetafields } from '../../../lib/shopify-gift-card-client.js';
import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { createVoucherLog } from '../../../lib/voucher-log-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const token = String(
    req.headers['x-admin-token'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return token === adminToken;
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseMoneyFromVoucherValue(value) {
  const normalized = String(value || '').replace('€', '').replace(/\s/g, '').replace(',', '.').trim();
  const amount = Number(normalized);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function getRange(req) {
  const query = req.query || {};
  const body = req.body || {};
  return {
    customerFrom: field(query.customerFrom || body.customerFrom || process.env.POINTS_SYNC_CUSTOMER_FROM || '1').trim(),
    customerTo: field(query.customerTo || body.customerTo || process.env.POINTS_SYNC_CUSTOMER_TO || '999999999').trim(),
    dateFrom: field(query.dateFrom || body.dateFrom || process.env.POINTS_SYNC_DATE_FROM || '2000-01-01').trim(),
    dateTo: field(query.dateTo || body.dateTo || new Date().toISOString().slice(0, 10)).trim()
  };
}

function getRules(req) {
  const query = req.query || {};
  const body = req.body || {};
  const voucherAmount = Number(String(query.voucherAmount || body.voucherAmount || process.env.LOYALTY_VOUCHER_MINIMUM || process.env.VOUCHER_MIN_AMOUNT_EUR || '25').replace(',', '.')) || 25;
  const pointValue = Number(String(query.pointValue || body.pointValue || process.env.VOUCHER_POINT_VALUE_EUR || '0.05').replace(',', '.')) || 0.05;
  const pointsPerVoucher = Math.ceil(voucherAmount / pointValue);
  const maxVouchersPerCustomer = Number(query.maxVouchersPerCustomer || body.maxVouchersPerCustomer || process.env.LOYALTY_VOUCHER_MAX_PER_CUSTOMER || 10) || 10;
  const limit = Number(query.limit || body.limit || 1) || 1;

  return { voucherAmount, pointValue, pointsPerVoucher, maxVouchersPerCustomer, limit };
}

function removeLeadingLetters(value) {
  return String(value || '').trim().replace(/^[A-Za-z]+/, '');
}

function uniqueIds(ids) {
  return Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
}

function splitCustomerTokens(value) {
  return String(value || '')
    .split(/[\s,;|]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function digitsOnly(value) {
  return String(value || '').replace(/\D/g, '');
}

function customerLookupIds(...ids) {
  const values = [];

  ids.forEach((id) => {
    splitCustomerTokens(id).forEach((part) => {
      const clean = String(part || '').trim();
      if (!clean) return;
      const withoutLetters = removeLeadingLetters(clean);
      values.push(withoutLetters, clean);
    });
  });

  return uniqueIds(values);
}

function srsVoucherCustomerId(balance) {
  const explicit = String(process.env.SRS_VOUCHER_CUSTOMER_ID_OVERRIDE || '').trim();
  if (explicit) return explicit;

  const originalTokens = splitCustomerTokens(balance.originalCustomerId || '');
  const normalizedTokens = splitCustomerTokens(balance.customerId || '');
  const tokens = [...originalTokens, ...normalizedTokens];

  const preferredShort = tokens
    .map((token) => removeLeadingLetters(token))
    .map((token) => digitsOnly(token))
    .find((token) => token.length >= 4 && token.length <= 6);

  if (preferredShort) return preferredShort;

  const longToken = tokens
    .map((token) => digitsOnly(token))
    .find((token) => token.length > 6);

  if (longToken) return longToken.slice(-5);

  const fallback = digitsOnly(removeLeadingLetters(balance.customerId || balance.originalCustomerId || ''));
  return fallback.length > 6 ? fallback.slice(-5) : fallback;
}

async function findShopifyCustomerForIds(ids, namespace, key) {
  for (const id of customerLookupIds(...ids)) {
    const customer = await findShopifyCustomerBySrsCustomerId(id, namespace, key);
    if (customer?.id) return { customer, matchedValue: id };
  }
  return { customer: null, matchedValue: '' };
}

async function resolveVoucherGroup(amount) {
  const groups = await getVoucherGroups();
  const matches = groups
    .filter((group) => Math.abs(parseMoneyFromVoucherValue(group.voucherValue) - amount) < 0.001)
    .sort((a, b) => Number(b.voucherGroupId) - Number(a.voucherGroupId));

  if (!matches[0]) {
    throw new Error(`Geen SRS vouchergroep gevonden voor €${amount.toFixed(2)}.`);
  }

  return matches[0];
}

async function updatePointsMetafield(customerId, balanceAfter) {
  if (!customerId) return [];
  const namespace = String(process.env.POINTS_METAFIELD_NAMESPACE || 'gents');
  const balanceKey = String(process.env.POINTS_METAFIELD_BALANCE_KEY || 'spaarpunten_saldo');
  const updatedKey = String(process.env.POINTS_METAFIELD_UPDATED_KEY || 'spaarpunten_laatst_bijgewerkt');

  return updateShopifyCustomerMetafields(customerId, [
    {
      namespace,
      key: balanceKey,
      type: 'number_integer',
      value: String(Math.max(0, Math.round(Number(balanceAfter || 0))))
    },
    {
      namespace,
      key: updatedKey,
      type: 'date_time',
      value: new Date().toISOString()
    }
  ]);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const dryRun = String(req.query.dryRun || req.body?.dryRun || 'true') !== 'false';
  const sendEmail = String(req.query.sendEmail || req.body?.sendEmail || 'true') !== 'false';
  const store = field(req.query.store || req.body?.store || 'GENTS Administratie').trim();
  const employeeName = field(req.query.employeeName || req.body?.employeeName || 'Beheerder').trim();
  const range = getRange(req);
  const rules = getRules(req);
  const validityMonths = Number(process.env.VOUCHER_VALIDITY_MONTHS || 3) || 3;
  const validFrom = isoDate(new Date());
  const validTo = isoDate(addMonths(new Date(), validityMonths));
  const srsCustomerNamespace = String(process.env.SRS_CUSTOMER_ID_METAFIELD_NAMESPACE || 'SRSERP');
  const srsCustomerKey = String(process.env.SRS_CUSTOMER_ID_METAFIELD_KEY || 'customer_id');

  try {
    const pointsSessionId = await loginSrsPointsService();
    const { balances } = await getPointsBalance({
      customerFrom: range.customerFrom,
      customerTo: range.customerTo,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      sessionId: pointsSessionId
    });

    const eligibleBalances = balances.filter((item) => Number(item.balance || 0) >= rules.pointsPerVoucher);
    const voucherGroup = dryRun ? null : await resolveVoucherGroup(rules.voucherAmount);
    const results = [];
    let processedCustomers = 0;

    for (const balance of eligibleBalances) {
      if (processedCustomers >= rules.limit) break;

      const srsCustomerId = String(balance.customerId || '').trim();
      const originalSrsCustomerId = String(balance.originalCustomerId || '').trim();
      const normalizedSrsCustomerId = removeLeadingLetters(originalSrsCustomerId || srsCustomerId);
      const voucherCustomerId = srsVoucherCustomerId(balance);
      const lookup = await findShopifyCustomerForIds([normalizedSrsCustomerId, srsCustomerId, originalSrsCustomerId, voucherCustomerId], srsCustomerNamespace, srsCustomerKey);
      const customer = lookup.customer;
      const customerEmail = String(customer?.email || '').trim();
      const customerName = String(customer?.displayName || [customer?.firstName, customer?.lastName].filter(Boolean).join(' ') || '').trim();
      const rawVoucherCount = Math.floor(Number(balance.balance || 0) / rules.pointsPerVoucher);
      const voucherCount = Math.min(rawVoucherCount, rules.maxVouchersPerCustomer);
      const redeemPointsTotal = voucherCount * rules.pointsPerVoucher;

      const customerResult = {
        srsCustomerId,
        originalSrsCustomerId,
        normalizedSrsCustomerId,
        srsVoucherCustomerId: voucherCustomerId,
        matchedValue: lookup.matchedValue,
        shopifyFound: Boolean(customer?.id),
        shopifyCustomerId: customer?.id || '',
        customerEmail,
        customerName,
        pointsBalance: Number(balance.balance || 0),
        pointsPerVoucher: rules.pointsPerVoucher,
        voucherCount,
        voucherAmount: rules.voucherAmount,
        totalVoucherAmount: Number((voucherCount * rules.voucherAmount).toFixed(2)),
        redeemPointsTotal,
        remainingPoints: Number(balance.balance || 0) - redeemPointsTotal,
        dryRun,
        vouchers: [],
        errors: []
      };

      if (!voucherCustomerId) {
        customerResult.errors.push('Geen geldig SRS klantnummer gevonden voor voucher aanmaken.');
        results.push(customerResult);
        continue;
      }

      if (!customer?.id || !customerEmail) {
        customerResult.errors.push(customer?.id ? 'Shopify klant heeft geen e-mail.' : 'Shopify klant niet gevonden.');
        results.push(customerResult);
        continue;
      }

      processedCustomers += 1;

      if (dryRun) {
        results.push(customerResult);
        continue;
      }

      for (let index = 0; index < voucherCount; index += 1) {
        try {
          const created = await makeVoucher({
            voucherType: voucherGroup.voucherGroupId,
            customerId: voucherCustomerId,
            validFrom,
            validTo
          });

          const checked = await checkVoucher({ barcode: created.barcode });
          const amount = Number(checked.amount || rules.voucherAmount).toFixed(2);

          let mailResult = null;
          if (sendEmail) {
            mailResult = await sendVoucherEmail({
              to: customerEmail,
              customerName,
              voucherCode: created.barcode,
              amount,
              currency: checked.currency || 'EUR',
              validFrom,
              validTo,
              shopifyEnabled: false,
              note: `Automatisch aangemaakt vanuit spaarpunten. Voucher ${index + 1} van ${voucherCount}.`
            });
          }

          const log = await createVoucherLog({
            store,
            employeeName,
            customerName,
            customerEmail,
            srsCustomerId: voucherCustomerId,
            voucherGroupId: voucherGroup.voucherGroupId,
            voucherCode: created.barcode,
            amount,
            currency: checked.currency || 'EUR',
            validFrom,
            validTo,
            mailed: Boolean(mailResult),
            shopifyEnabled: false,
            note: `${rules.pointsPerVoucher} spaarpunten verzilverd. Automatische loyalty voucher ${index + 1}/${voucherCount}. Shopify matchwaarde: ${lookup.matchedValue || '-'}.`,
            status: 'Aangemaakt'
          });

          customerResult.vouchers.push({
            code: created.barcode,
            amount,
            currency: checked.currency || 'EUR',
            validFrom,
            validTo,
            mailed: Boolean(mailResult),
            logId: log.id
          });
        } catch (error) {
          customerResult.errors.push(error.message || 'Voucher aanmaken mislukt.');
          await createVoucherLog({
            store,
            employeeName,
            customerName,
            customerEmail,
            srsCustomerId: voucherCustomerId,
            amount: rules.voucherAmount,
            currency: 'EUR',
            mailed: false,
            shopifyEnabled: false,
            note: `Automatische loyalty voucher mislukt. Shopify matchwaarde: ${lookup.matchedValue || '-'}.`,
            status: 'Mislukt',
            error: error.message || 'Voucher aanmaken mislukt.'
          });
        }
      }

      if (customerResult.vouchers.length === voucherCount) {
        const redeemed = await changePoints({
          customerId: voucherCustomerId,
          action: 'redeem',
          points: redeemPointsTotal,
          sender: 'Webshop',
          sessionId: pointsSessionId
        });
        customerResult.pointsRedeem = redeemed;
        customerResult.remainingPoints = Number.isFinite(redeemed.balanceAfter) ? redeemed.balanceAfter : customerResult.remainingPoints;
        await updatePointsMetafield(customer.id, customerResult.remainingPoints);
      } else {
        customerResult.errors.push('Niet alle vouchers zijn aangemaakt; punten zijn daarom niet afgeboekt. Controleer handmatig.');
      }

      results.push(customerResult);
    }

    const vouchersCreated = results.reduce((sum, item) => sum + Number(item.vouchers?.length || 0), 0);

    return res.status(200).json({
      success: true,
      dryRun,
      range,
      rules,
      validFrom,
      validTo,
      totalBalances: balances.length,
      eligibleCustomers: eligibleBalances.length,
      processedCustomers,
      vouchersPlanned: results.reduce((sum, item) => sum + Number(item.voucherCount || 0), 0),
      vouchersCreated,
      totalVoucherAmount: Number(results.reduce((sum, item) => sum + Number(item.totalVoucherAmount || 0), 0).toFixed(2)),
      results
    });
  } catch (error) {
    console.error('Generate eligible vouchers error:', error);
    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Eligible vouchers konden niet worden gegenereerd.',
      details: error.fault || null
    });
  }
}
