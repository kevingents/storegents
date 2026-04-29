import { placeInterstoreWeborder } from '../../lib/srs-weborder-client.js';
import { createWeborderRequest } from '../../lib/weborder-request-store.js';
import { getBranchIdByStore } from '../../lib/branch-metrics.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

function isAllowed(req) {
  const token = process.env.ADMIN_TOKEN || '12345';
  const headerToken = req.headers['x-admin-token'];
  return !process.env.REQUIRE_WEBORDER_TOKEN || headerToken === token;
}

function required(value, label) {
  if (!String(value || '').trim()) {
    throw new Error(`${label} is verplicht.`);
  }

  return String(value).trim();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      message: 'Alleen POST is toegestaan.'
    });
  }

  if (!isAllowed(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  const body = req.body || {};

  try {
    const sellingStore = required(field(body.sellingStore), 'Verkoopwinkel');
    const fulfilmentStore = required(field(body.fulfilmentStore), 'Verzendwinkel');

    const sellingBranchId = field(body.sellingBranchId) || getBranchIdByStore(sellingStore);
    const fulfilmentBranchId = field(body.fulfilmentBranchId) || getBranchIdByStore(fulfilmentStore);

    if (!sellingBranchId) throw new Error(`Geen SRS filiaalnummer gevonden voor ${sellingStore}.`);
    if (!fulfilmentBranchId) throw new Error(`Geen SRS filiaalnummer gevonden voor ${fulfilmentStore}.`);

    const customerName = required(field(body.customerName), 'Klantnaam');
    const customerEmail = required(field(body.customerEmail), 'Klant e-mail');
    const sku = required(field(body.sku), 'Barcode/SKU');
    const productName = required(field(body.productName), 'Productnaam');
    const productPrice = Number(body.productPrice || 0);

    if (!Number.isFinite(productPrice) || productPrice <= 0) {
      throw new Error('Productprijs moet hoger dan 0 zijn.');
    }

    const quantity = Math.max(1, Number(body.quantity || 1));

    const payload = {
      sellingStore,
      sellingBranchId,
      fulfilmentStore,
      fulfilmentBranchId,
      sellerId: field(body.sellerId),
      customerId: field(body.customerId),
      customer: {
        name: customerName,
        street: required(field(body.street), 'Straat'),
        houseNumber: field(body.houseNumber),
        address2: field(body.address2),
        postalCode: required(field(body.postalCode), 'Postcode'),
        city: required(field(body.city), 'Plaats'),
        country: field(body.country) || 'NL',
        email: customerEmail,
        phone: field(body.customerPhone),
        mobile: field(body.customerMobile) || field(body.customerPhone)
      },
      email: customerEmail,
      phone: field(body.customerPhone),
      mobile: field(body.customerMobile) || field(body.customerPhone),
      product: {
        sku,
        name: productName,
        price: productPrice,
        quantity,
        taxPerc: Number(body.taxPerc || 21)
      },
      shippingCost: Number(body.shippingCost || 0),
      paymentType: field(body.paymentType) || process.env.SRS_WEBORDER_PAYMENT_TYPE || 'eft',
      note: field(body.note)
    };

    const srsResult = await placeInterstoreWeborder(payload);

    const record = await createWeborderRequest({
      orderId: srsResult.orderId,
      srsCreated: true,
      status: 'srs_created',
      sellingStore,
      sellingBranchId,
      fulfilmentStore,
      fulfilmentBranchId,
      customerName,
      customerEmail,
      customerPhone: field(body.customerPhone),
      sku,
      productName,
      productPrice,
      quantity,
      shippingCost: Number(body.shippingCost || 0),
      paymentType: payload.paymentType,
      employeeName: field(body.employeeName),
      note: field(body.note),
      srsResponse: {
        total: srsResult.total,
        srsReturn: srsResult.srsReturn
      }
    });

    return res.status(200).json({
      success: true,
      message: 'Weborder is aangemaakt in SRS.',
      orderId: srsResult.orderId,
      record
    });
  } catch (error) {
    console.error('Create interstore weborder error:', error);

    try {
      await createWeborderRequest({
        status: 'mislukt',
        srsCreated: false,
        sellingStore: field(body.sellingStore),
        sellingBranchId: field(body.sellingBranchId) || getBranchIdByStore(field(body.sellingStore)),
        fulfilmentStore: field(body.fulfilmentStore),
        fulfilmentBranchId: field(body.fulfilmentBranchId) || getBranchIdByStore(field(body.fulfilmentStore)),
        customerName: field(body.customerName),
        customerEmail: field(body.customerEmail),
        customerPhone: field(body.customerPhone),
        sku: field(body.sku),
        productName: field(body.productName),
        productPrice: Number(body.productPrice || 0),
        quantity: Number(body.quantity || 1),
        shippingCost: Number(body.shippingCost || 0),
        paymentType: field(body.paymentType),
        employeeName: field(body.employeeName),
        note: field(body.note),
        error: error.message || 'Weborder aanmaken mislukt.'
      });
    } catch (logError) {
      console.error('Log failed weborder error:', logError);
    }

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'Weborder kon niet worden aangemaakt.',
      details: error.fault || null
    });
  }
}
