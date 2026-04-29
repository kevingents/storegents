import { getVoucherGroups, makeVoucher, checkVoucher } from '../../../lib/srs-vouchers-client.js';
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

function pointsToAmount(points) {
  const pointValue = Number(String(process.env.VOUCHER_POINT_VALUE_EUR || '0.05').replace(',', '.'));
  const safePointValue = Number.isFinite(pointValue) && pointValue > 0 ? pointValue : 0.05;
  return Number((Number(points || 0) * safePointValue).toFixed(2));
}

async function resolveVoucherGroup({ requestedAmount, voucherGroupId }) {
  const groups = await getVoucherGroups();

  if (voucherGroupId) {
    const selected = groups.find((group) => String(group.voucherGroupId) === String(voucherGroupId));

    if (!selected) {
      throw new Error(`Vouchergroep ${voucherGroupId} is niet gevonden in SRS.`);
    }

    return {
      group: selected,
      groups,
      groupAmount: parseMoneyFromVoucherValue(selected.voucherValue)
    };
  }

  const matches = groups
    .filter((group) => {
      const groupAmount = parseMoneyFromVoucherValue(group.voucherValue);
      return Math.abs(groupAmount - requestedAmount) < 0.001;
    })
    .sort((a, b) => Number(b.voucherGroupId) - Number(a.voucherGroupId));

  const matched = matches[0];

  if (!matched) {
    const available = groups
      .filter((group) => parseMoneyFromVoucherValue(group.voucherValue) >= 25)
      .map((group) => `${group.voucherGroupName || 'Groep ' + group.voucherGroupId}: ${group.voucherValue || '-'}`)
      .join(' | ');

    throw new Error(
      `Geen SRS vouchergroep gevonden voor €${requestedAmount.toFixed(2)}. Kies handmatig een vouchergroep of maak deze waarde aan in SRS. Beschikbaar vanaf €25: ${available}`
    );
  }

  return {
    group: matched,
    groups,
    groupAmount: parseMoneyFromVoucherValue(matched.voucherValue)
  };
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
  const customerName = field(body.customerName).trim();
  const customerEmail = field(body.customerEmail).trim();
  const srsCustomerId = field(body.srsCustomerId).trim();
  const voucherGroupId = field(body.voucherGroupId).trim();
  const note = field(body.note).trim();
  const makeAvailableInShopify = Boolean(body.makeAvailableInShopify);
  const sendEmail = body.sendEmail !== false;

  const points = Number(field(body.points) || 0);
  const amountFromBody = Number(String(field(body.amount) || '').replace(',', '.'));
  const amount = Number.isFinite(amountFromBody) && amountFromBody > 0
    ? Number(amountFromBody.toFixed(2))
    : pointsToAmount(points);

  const minimumAmount = Number(String(process.env.VOUCHER_MIN_AMOUNT_EUR || '25').replace(',', '.')) || 25;
  const validityMonths = Number(process.env.VOUCHER_VALIDITY_MONTHS || 3) || 3;

  try {
    if (!employeeName || !customerEmail || !srsCustomerId) {
      return res.status(400).json({
        success: false,
        message: 'Vul medewerker, klant e-mail en SRS klant ID in.'
      });
    }

    if (!Number.isFinite(amount) || amount < minimumAmount) {
      const minimumPoints = Math.ceil(minimumAmount / Number(String(process.env.VOUCHER_POINT_VALUE_EUR || '0.05').replace(',', '.')));
      return res.status(400).json({
        success: false,
        message: `Voucherbedrag moet minimaal €${minimumAmount.toFixed(2)} zijn. Dat is minimaal ${minimumPoints} punten.`
      });
    }

    const validFrom = isoDate(new Date());
    const validTo = isoDate(addMonths(new Date(), validityMonths));

    const { group, groupAmount } = await resolveVoucherGroup({
      requestedAmount: amount,
      voucherGroupId
    });

    const created = await makeVoucher({
      voucherType: group.voucherGroupId,
      customerId: srsCustomerId,
      validFrom,
      validTo
    });

    const checked = await checkVoucher({
      barcode: created.barcode
    });

    const checkedAmount = Number(checked.amount || groupAmount || amount).toFixed(2);

    let shopifyResult = null;
    let shopifyError = '';

    if (makeAvailableInShopify) {
      try {
        shopifyResult = await createShopifyGiftCard({
          code: created.barcode,
          amount: checkedAmount,
          currencyCode: checked.currency || 'EUR',
          expiresOn: validTo,
          note: `SRS puntenvoucher ${created.barcode}. ${points ? points + ' punten. ' : ''}Aangemaakt door ${employeeName}.`,
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
        amount: checkedAmount,
        currency: checked.currency || 'EUR',
        validFrom,
        validTo,
        shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
        note
      });
    }

    const log = await createVoucherLog({
      store,
      employeeName,
      customerName,
      customerEmail,
      srsCustomerId,
      voucherGroupId: group.voucherGroupId,
      voucherCode: created.barcode,
      amount: checkedAmount,
      currency: checked.currency || 'EUR',
      validFrom,
      validTo,
      mailed: Boolean(mailResult),
      shopifyEnabled: Boolean(shopifyResult?.giftCard?.id),
      shopifyGiftCardId: shopifyResult?.giftCard?.id || '',
      shopifyGiftCardLastCharacters: shopifyResult?.giftCard?.lastCharacters || '',
      shopifyCustomerId: shopifyResult?.customer?.id || '',
      note: `${points ? points + ' punten. ' : ''}${note}`,
      status: shopifyError ? 'SRS aangemaakt, mail verzonden, Shopify mislukt' : 'Aangemaakt',
      error: shopifyError
    });

    return res.status(200).json({
      success: true,
      message: shopifyError
        ? 'Voucher is aangemaakt en gemaild. Shopify gift card kon niet worden aangemaakt.'
        : 'Voucher is aangemaakt en gemaild.',
      voucher: {
        code: created.barcode,
        points,
        amount: checkedAmount,
        currency: checked.currency || 'EUR',
        validFrom,
        validTo,
        srsCustomerId,
        voucherGroup: group,
        status: checked.status,
        info: checked.info
      },
      shopify: shopifyResult,
      shopifyError,
      log
    });
  } catch (error) {
    console.error('Admin generate voucher error:', error);

    await createVoucherLog({
      store,
      employeeName,
      customerName,
      customerEmail,
      srsCustomerId,
      voucherGroupId,
      amount: amount || '',
      currency: 'EUR',
      mailed: false,
      shopifyEnabled: false,
      note,
      status: 'Mislukt',
      error: error.message || 'Voucher genereren mislukt.'
    });

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Voucher kon niet worden gegenereerd.',
      details: error.fault || null
    });
  }
}
