import {
  getVoucherGroups,
  makeVouchersInBulk,
  checkVoucher
} from '../../../lib/srs-vouchers-client.js';
import { createShopifyGiftCard } from '../../../lib/shopify-gift-card-client.js';
import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { createVoucherLog } from '../../../lib/voucher-log-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function parseMoneyFromVoucherValue(value) {
  const normalized = String(value || '')
    .replace('€', '')
    .replace(/\s/g, '')
    .replace(',', '.')
    .trim();

  const amount = Number(normalized);
  return Number.isFinite(amount) ? Number(amount.toFixed(2)) : 0;
}

function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function pointValue() {
  const raw = String(process.env.VOUCHER_POINT_VALUE_EUR || '0.05').replace(',', '.');
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 0.05;
}

function minimumAmount() {
  const raw = String(process.env.VOUCHER_MIN_AMOUNT_EUR || '25').replace(',', '.');
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : 25;
}

function validityMonths() {
  const value = Number(process.env.VOUCHER_VALIDITY_MONTHS || 3);
  return Number.isFinite(value) && value > 0 ? value : 3;
}

function pointsToAmount(points) {
  return Number((Number(points || 0) * pointValue()).toFixed(2));
}

function normalizeCustomer(input, index) {
  const srsCustomerId = String(
    input.srsCustomerId ||
    input.customerId ||
    input.klantId ||
    input.klant_id ||
    ''
  ).trim();

  const customerEmail = String(
    input.customerEmail ||
    input.email ||
    input.emailadres ||
    ''
  ).trim();

  const customerName = String(
    input.customerName ||
    input.name ||
    input.naam ||
    ''
  ).trim();

  const points = Number(
    String(input.points || input.punten || 0)
      .replace(',', '.')
      .trim()
  );

  const amount = pointsToAmount(points);

  return {
    rowNumber: index + 1,
    srsCustomerId,
    customerEmail,
    customerName,
    points,
    amount,
    raw: input
  };
}

async function buildVoucherGroupMap() {
  const groups = await getVoucherGroups();
  const map = new Map();

  groups.forEach((group) => {
    const amount = parseMoneyFromVoucherValue(group.voucherValue);
    if (amount <= 0) return;

    const existing = map.get(amount);
    if (!existing || Number(group.voucherGroupId) > Number(existing.voucherGroupId)) {
      map.set(amount, group);
    }
  });

  return { groups, map };
}

function groupCustomersByAmount(customers, groupMap) {
  const grouped = new Map();

  customers.forEach((customer) => {
    const group = groupMap.get(customer.amount);

    if (!group) {
      customer.error = `Geen SRS vouchergroep gevonden voor €${customer.amount.toFixed(2)}.`;
      return;
    }

    const key = String(group.voucherGroupId);
    const existing = grouped.get(key) || {
      voucherGroup: group,
      amount: customer.amount,
      customers: []
    };

    existing.customers.push(customer);
    grouped.set(key, existing);
  });

  return Array.from(grouped.values());
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

  const body = req.body || {};
  const store = field(body.store).trim() || 'GENTS Administratie';
  const employeeName = field(body.employeeName).trim();
  const note = field(body.note).trim();
  const makeAvailableInShopify = Boolean(body.makeAvailableInShopify);
  const sendEmail = body.sendEmail !== false;
  const dryRun = Boolean(body.dryRun);
  const customersRaw = Array.isArray(body.customers) ? body.customers : [];

  const validFrom = field(body.validFrom).trim() || isoDate(new Date());
  const validTo = field(body.validTo).trim() || isoDate(addMonths(new Date(), validityMonths()));

  try {
    if (!employeeName) {
      return res.status(400).json({
        success: false,
        message: 'Vul administratie medewerker in.'
      });
    }

    if (!customersRaw.length) {
      return res.status(400).json({
        success: false,
        message: 'Geen klanten ontvangen.'
      });
    }

    const minAmount = minimumAmount();
    const minPoints = Math.ceil(minAmount / pointValue());

    const normalized = customersRaw.map(normalizeCustomer);
    const validCustomers = [];
    const skipped = [];

    normalized.forEach((customer) => {
      if (!customer.srsCustomerId) {
        skipped.push({ ...customer, error: 'SRS klant ID ontbreekt.' });
        return;
      }

      if (!customer.customerEmail) {
        skipped.push({ ...customer, error: 'Klant e-mail ontbreekt.' });
        return;
      }

      if (!Number.isFinite(customer.points) || customer.points < minPoints) {
        skipped.push({
          ...customer,
          error: `Niet genoeg punten. Minimaal ${minPoints} punten nodig voor €${minAmount.toFixed(2)}.`
        });
        return;
      }

      validCustomers.push(customer);
    });

    const { groups, map } = await buildVoucherGroupMap();
    const grouped = groupCustomersByAmount(validCustomers, map);

    validCustomers
      .filter((customer) => customer.error)
      .forEach((customer) => skipped.push(customer));

    const readyCustomers = grouped.flatMap((group) => group.customers);

    if (dryRun) {
      return res.status(200).json({
        success: true,
        dryRun: true,
        message: 'Controle klaar. Er zijn nog geen vouchers aangemaakt.',
        totals: {
          received: customersRaw.length,
          ready: readyCustomers.length,
          skipped: skipped.length,
          groups: grouped.length
        },
        groups: grouped.map((group) => ({
          voucherGroupId: group.voucherGroup.voucherGroupId,
          voucherGroupName: group.voucherGroup.voucherGroupName,
          voucherValue: group.voucherGroup.voucherValue,
          amount: group.amount,
          customerCount: group.customers.length
        })),
        skipped,
        availableVoucherGroups: groups
      });
    }

    const results = [];

    for (const batch of grouped) {
      const vouchers = await makeVouchersInBulk({
        voucherType: batch.voucherGroup.voucherGroupId,
        customerIds: batch.customers.map((customer) => customer.srsCustomerId),
        validFrom,
        validTo
      });

      for (const customer of batch.customers) {
        const voucher = vouchers.find((item) => String(item.customerId) === String(customer.srsCustomerId));

        if (!voucher?.barcode) {
          const failed = {
            ...customer,
            voucherGroupId: batch.voucherGroup.voucherGroupId,
            success: false,
            error: 'SRS gaf geen barcode terug voor deze klant.'
          };
          results.push(failed);

          await createVoucherLog({
            store,
            employeeName,
            customerName: customer.customerName,
            customerEmail: customer.customerEmail,
            srsCustomerId: customer.srsCustomerId,
            voucherGroupId: batch.voucherGroup.voucherGroupId,
            amount: customer.amount,
            currency: 'EUR',
            validFrom,
            validTo,
            mailed: false,
            shopifyEnabled: false,
            note: `${customer.points} punten. ${note}`,
            status: 'Bulk mislukt',
            error: failed.error
          });

          continue;
        }

        let checked = null;
        let shopifyResult = null;
        let shopifyError = '';
        let mailResult = null;

        try {
          checked = await checkVoucher({ barcode: voucher.barcode });
        } catch (error) {
          checked = {
            amount: customer.amount.toFixed(2),
            currency: 'EUR',
            status: '',
            info: error.message
          };
        }

        if (makeAvailableInShopify) {
          try {
            shopifyResult = await createShopifyGiftCard({
              code: voucher.barcode,
              amount: checked.amount || customer.amount.toFixed(2),
              currencyCode: checked.currency || 'EUR',
              expiresOn: validTo,
              note: `Bulk puntenvoucher ${voucher.barcode}. ${customer.points} punten. Aangemaakt door ${employeeName}.`,
              customerEmail: customer.customerEmail
            });
          } catch (error) {
            shopifyError = error.message || 'Shopify gift card kon niet worden aangemaakt.';
          }
        }

        if (sendEmail) {
          try {
            mailResult = await sendVoucherEmail({
              to: customer.customerEmail,
              customerName: customer.customerName,
              voucherCode: voucher.barcode,
              amount: checked.amount || customer.amount.toFixed(2),
              currency: checked.currency || 'EUR',
              validFrom,
              validTo,
              shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
              note
            });
          } catch (error) {
            results.push({
              ...customer,
              voucherCode: voucher.barcode,
              voucherGroupId: batch.voucherGroup.voucherGroupId,
              success: false,
              error: `Voucher aangemaakt, maar mail mislukt: ${error.message}`
            });
          }
        }

        const status = shopifyError
          ? 'Bulk aangemaakt, Shopify mislukt'
          : 'Bulk aangemaakt';

        await createVoucherLog({
          store,
          employeeName,
          customerName: customer.customerName,
          customerEmail: customer.customerEmail,
          srsCustomerId: customer.srsCustomerId,
          voucherGroupId: batch.voucherGroup.voucherGroupId,
          voucherCode: voucher.barcode,
          amount: checked.amount || customer.amount.toFixed(2),
          currency: checked.currency || 'EUR',
          validFrom,
          validTo,
          mailed: Boolean(mailResult),
          shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
          shopifyGiftCardId: shopifyResult?.giftCard?.id || '',
          shopifyGiftCardLastCharacters: shopifyResult?.giftCard?.lastCharacters || '',
          shopifyCustomerId: shopifyResult?.customer?.id || '',
          note: `${customer.points} punten. ${note}`,
          status,
          error: shopifyError
        });

        results.push({
          ...customer,
          voucherCode: voucher.barcode,
          voucherGroupId: batch.voucherGroup.voucherGroupId,
          voucherGroupName: batch.voucherGroup.voucherGroupName,
          success: true,
          mailed: Boolean(mailResult),
          shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
          shopifyError
        });
      }
    }

    return res.status(200).json({
      success: true,
      message: 'Bulk vouchers verwerkt.',
      totals: {
        received: customersRaw.length,
        created: results.filter((item) => item.success).length,
        failed: results.filter((item) => !item.success).length,
        skipped: skipped.length,
        groups: grouped.length
      },
      validFrom,
      validTo,
      skipped,
      results
    });
  } catch (error) {
    console.error('Bulk generate vouchers error:', error);

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Bulk vouchers konden niet worden gegenereerd.',
      details: error.fault || null
    });
  }
}
