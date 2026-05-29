import {
  loginSrsPointsService,
  getPointsBalance,
  changePoints
} from '../../../lib/srs-points-client.js';
import { getCustomers } from '../../../lib/srs-customers-client.js';
import { getVoucherGroups, makeVoucher, checkVoucher } from '../../../lib/srs-vouchers-client.js';
import { findShopifyCustomerBySrsCustomerId, updateShopifyCustomerMetafields } from '../../../lib/shopify-gift-card-client.js';
import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { createVoucherLog, getVoucherLogs } from '../../../lib/voucher-log-store.js';
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
  const duplicateWindowDays = Number(query.duplicateWindowDays || body.duplicateWindowDays || process.env.LOYALTY_VOUCHER_DUPLICATE_WINDOW_DAYS || 120) || 120;

  return { voucherAmount, pointValue, pointsPerVoucher, maxVouchersPerCustomer, limit, duplicateWindowDays };
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

  const firstLongToken = tokens
    .map((token) => digitsOnly(token))
    .find((token) => token.length > 6);

  if (firstLongToken) return firstLongToken.slice(-5);

  const preferredShort = tokens
    .map((token) => removeLeadingLetters(token))
    .map((token) => digitsOnly(token))
    .find((token) => token.length >= 4 && token.length <= 6);

  if (preferredShort) return preferredShort;

  const fallback = digitsOnly(removeLeadingLetters(balance.customerId || balance.originalCustomerId || ''));
  return fallback.length > 6 ? fallback.slice(-5) : fallback;
}

function srsPointsCustomerId(balance) {
  return String(balance.originalCustomerId || balance.customerId || '').trim();
}

function srsCustomerLookupIds(balance, voucherCustomerId) {
  const tokens = [
    ...splitCustomerTokens(balance.originalCustomerId || ''),
    ...splitCustomerTokens(balance.customerId || '')
  ];

  const shortTokens = tokens
    .map((token) => digitsOnly(removeLeadingLetters(token)))
    .filter((token) => token.length >= 4 && token.length <= 6);

  return uniqueIds([...shortTokens, voucherCustomerId]);
}

async function getSrsCustomerForBalance(balance, voucherCustomerId) {
  for (const id of srsCustomerLookupIds(balance, voucherCustomerId)) {
    try {
      const result = await getCustomers({ customerId: id });
      const customer = result.customers?.[0] || null;
      if (customer?.customerId || customer?.email || customer?.name) {
        return { customer, matchedValue: id };
      }
    } catch (error) {
      console.error('SRS customer lookup failed:', id, error.message);
    }
  }

  return { customer: null, matchedValue: '' };
}

function customerNameFromSrs(customer = {}) {
  return String(customer.name || [customer.title, customer.firstName, customer.lastName].filter(Boolean).join(' ') || '').trim();
}

function isRecentAutomaticLoyaltyLog(log, customerId, customerEmail, duplicateWindowDays) {
  const logCustomerId = String(log.srsCustomerId || '').trim();
  const logEmail = String(log.customerEmail || '').trim().toLowerCase();
  const email = String(customerEmail || '').trim().toLowerCase();
  const note = String(log.note || '').toLowerCase();
  const status = String(log.status || '').toLowerCase();
  const createdAt = new Date(log.createdAt || 0).getTime();
  const cutoff = Date.now() - duplicateWindowDays * 24 * 60 * 60 * 1000;

  if (!createdAt || Number.isNaN(createdAt) || createdAt < cutoff) return false;
  if (status.includes('mislukt') || status.includes('failed')) return false;
  if (!note.includes('automatische loyalty voucher') && !note.includes('spaarpunten voucher')) return false;

  return logCustomerId === String(customerId || '').trim() || (email && logEmail === email);
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
  const redeemPoints = String(req.query.redeemPoints || req.body?.redeemPoints || 'false') === 'true';
  const allowDuplicates = String(req.query.allowDuplicates || req.body?.allowDuplicates || 'false') === 'true';
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
    const voucherLogs = await getVoucherLogs();
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
      const pointsCustomerId = srsPointsCustomerId(balance);
      const srsCustomerLookup = await getSrsCustomerForBalance(balance, voucherCustomerId);
      const srsCustomer = srsCustomerLookup.customer;
      const srsCustomerEmail = String(srsCustomer?.email || '').trim();
      const srsCustomerName = customerNameFromSrs(srsCustomer);
      const lookup = await findShopifyCustomerForIds([normalizedSrsCustomerId, srsCustomerId, originalSrsCustomerId, voucherCustomerId, srsCustomerLookup.matchedValue], srsCustomerNamespace, srsCustomerKey);
      const shopifyCustomer = lookup.customer;
      const shopifyCustomerEmail = String(shopifyCustomer?.email || '').trim();
      const shopifyCustomerName = String(shopifyCustomer?.displayName || [shopifyCustomer?.firstName, shopifyCustomer?.lastName].filter(Boolean).join(' ') || '').trim();
      const customerEmail = srsCustomerEmail;
      const customerName = srsCustomerName;
      const rawVoucherCount = Math.floor(Number(balance.balance || 0) / rules.pointsPerVoucher);
      const voucherCount = Math.min(rawVoucherCount, rules.maxVouchersPerCustomer);
      const redeemPointsTotal = voucherCount * rules.pointsPerVoucher;
      const duplicateLogs = voucherLogs.filter((log) => isRecentAutomaticLoyaltyLog(log, voucherCustomerId, customerEmail, rules.duplicateWindowDays));

      const customerResult = {
        srsCustomerId,
        originalSrsCustomerId,
        normalizedSrsCustomerId,
        srsVoucherCustomerId: voucherCustomerId,
        srsPointsCustomerId: pointsCustomerId,
        srsCustomerLookupId: srsCustomerLookup.matchedValue,
        srsCustomerFound: Boolean(srsCustomer),
        srsCustomerEmail,
        srsCustomerName,
        shopifyMatchedValue: lookup.matchedValue,
        shopifyFound: Boolean(shopifyCustomer?.id),
        shopifyCustomerId: shopifyCustomer?.id || '',
        shopifyCustomerEmail,
        shopifyCustomerName,
        emailUsed: customerEmail,
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
        redeemPoints,
        duplicateProtection: !allowDuplicates,
        duplicateWindowDays: rules.duplicateWindowDays,
        duplicateVoucherCount: duplicateLogs.length,
        duplicateVoucherCodes: duplicateLogs.map((log) => log.voucherCode).filter(Boolean),
        vouchers: [],
        errors: []
      };

      if (!voucherCustomerId) {
        customerResult.errors.push('Geen geldig SRS klantnummer gevonden voor voucher aanmaken.');
        results.push(customerResult);
        continue;
      }

      if (!srsCustomer?.customerId) {
        customerResult.errors.push('SRS klant niet gevonden via Customers. Er wordt niet gemaild op basis van Shopify.');
        results.push(customerResult);
        continue;
      }

      if (!customerEmail) {
        customerResult.errors.push('SRS klant heeft geen e-mail. Er wordt niet gemaild op basis van Shopify.');
        results.push(customerResult);
        continue;
      }

      if (!allowDuplicates && duplicateLogs.length) {
        customerResult.skipped = true;
        customerResult.skipReason = 'duplicate_automatic_loyalty_voucher';
        customerResult.voucherCount = 0;
        customerResult.totalVoucherAmount = 0;
        customerResult.redeemPointsTotal = 0;
        customerResult.remainingPoints = Number(balance.balance || 0);
        customerResult.errors.push(`Overgeslagen: er bestaan al automatische loyalty vouchers voor deze klant binnen ${rules.duplicateWindowDays} dagen.`);
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
            note: `${rules.pointsPerVoucher} spaarpunten voucher aangemaakt. Puntenafboeking: ${redeemPoints ? 'aan' : 'uit'}. Automatische loyalty voucher ${index + 1}/${voucherCount}. SRS Customers lookup: ${srsCustomerLookup.matchedValue || '-'}. Shopify matchwaarde: ${lookup.matchedValue || '-'}.`,
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
            note: `Automatische loyalty voucher mislukt. SRS Customers lookup: ${srsCustomerLookup.matchedValue || '-'}. Shopify matchwaarde: ${lookup.matchedValue || '-'}.`,
            status: 'Mislukt',
            error: error.message || 'Voucher aanmaken mislukt.'
          });
        }
      }

      if (customerResult.vouchers.length === voucherCount) {
        if (redeemPoints) {
          const redeemed = await changePoints({
            customerId: pointsCustomerId,
            action: 'redeem',
            points: redeemPointsTotal,
            sender: 'Webshop',
            sessionId: pointsSessionId
          });
          customerResult.pointsRedeem = redeemed;
          customerResult.remainingPoints = Number.isFinite(redeemed.balanceAfter) ? redeemed.balanceAfter : customerResult.remainingPoints;
          if (shopifyCustomer?.id) await updatePointsMetafield(shopifyCustomer.id, customerResult.remainingPoints);
        } else {
          customerResult.pointsRedeemSkipped = true;
          customerResult.errors.push('Punten zijn nog niet afgeboekt omdat redeemPoints=false. Controleer eerst welk SRS klantnummer changePoints verwacht.');
        }
      } else {
        customerResult.errors.push('Niet alle vouchers zijn aangemaakt; punten zijn daarom niet afgeboekt. Controleer handmatig.');
      }

      results.push(customerResult);
    }

    const vouchersCreated = results.reduce((sum, item) => sum + Number(item.vouchers?.length || 0), 0);

    return res.status(200).json({
      success: true,
      dryRun,
      redeemPoints,
      allowDuplicates,
      emailSource: 'srs_customers',
      range,
      rules,
      validFrom,
      validTo,
      totalBalances: balances.length,
      eligibleCustomers: eligibleBalances.length,
      processedCustomers,
      skippedCustomers: results.filter((item) => item.skipped).length,
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
