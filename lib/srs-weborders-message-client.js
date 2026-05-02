import crypto from 'crypto';
import { getStoreNameByBranchId } from './branch-metrics.js';
import { normalizeWeborder } from './weborder-request-store.js';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.storeinfo.nl';
const WEBORDERS_MESSAGE_PATH = '/messages/v1/soap/Weborders.php';
const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 20000);

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function timestamp(value) {
  if (value) return String(value).slice(0, 19);
  return new Date().toISOString().slice(0, 19);
}

function getConfig() {
  const id = process.env.SRS_MESSAGE_USER || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || '';
  const baseUrl = (process.env.SRS_MESSAGE_BASE_URL || process.env.SRS_BASE_URL || DEFAULT_SRS_MESSAGE_BASE_URL).replace(/\/$/, '');

  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken.');
  }

  return { id, password, endpoint: `${baseUrl}${WEBORDERS_MESSAGE_PATH}` };
}

function loginXml(ns = 'data') {
  const { id, password } = getConfig();
  return `
    <${ns}:Login>
      <com:Id>${xmlEscape(id)}</com:Id>
      <com:Password>${xmlEscape(password)}</com:Password>
    </${ns}:Login>`;
}

function transactionHeaderXml() {
  const { id, password } = getConfig();
  return `
    <tran:Header>
      <com:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </com:Login>
      <com:TransactionId>${uuid()}</com:TransactionId>
      <com:Timestamp>${timestamp()}</com:Timestamp>
    </tran:Header>`;
}

function getNodeText(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const match = String(xml || '').match(regex);
  return match ? match[1].trim() : '';
}

function getAllBlocks(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'gi');
  return Array.from(String(xml || '').matchAll(regex)).map((match) => match[1]);
}

function parseSoapFault(xml) {
  const faultString = getNodeText(xml, 'faultstring') || getNodeText(xml, 'Reason') || getNodeText(xml, 'Text');
  const faultCode = getNodeText(xml, 'faultcode') || getNodeText(xml, 'Code');
  if (!faultString && !faultCode) return null;
  return { code: faultCode, message: faultString || 'SRS SOAP fault' };
}

async function postSoap(action, xml) {
  const { endpoint } = getConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(SOAP_TIMEOUT_MS) && SOAP_TIMEOUT_MS > 0 ? SOAP_TIMEOUT_MS : 20000);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: action
      },
      body: xml,
      signal: controller.signal
    });

    const text = await response.text();
    const fault = parseSoapFault(text);

    if (!response.ok || fault) {
      const error = new Error(fault?.message || `SRS Weborders fout: ${response.status}`);
      error.status = response.status;
      error.fault = fault;
      error.responseText = text;
      throw error;
    }

    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`SRS timeout na ${SOAP_TIMEOUT_MS}ms (${action}).`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function fulfillmentFromBlock(block) {
  const branchId = getNodeText(block, 'BranchId');
  const status = getNodeText(block, 'Status') || 'accepted';
  const orderNr = getNodeText(block, 'OrderNr');
  const sku = getNodeText(block, 'Sku') || getNodeText(block, 'Barcode');
  const createdAt = getNodeText(block, 'CreatedAt');
  const updatedAt = getNodeText(block, 'UpdatedAt');
  const fulfillmentId = getNodeText(block, 'FulfillmentId');
  const orderLineNr = getNodeText(block, 'OrderLineNr');
  const multipleFulfillmentsOpen = getNodeText(block, 'MultipleFulfillmentsOpen');

  return normalizeWeborder({
    source: 'srs_get_fulfillments',
    id: fulfillmentId || `${orderNr}-${orderLineNr || sku}-${branchId}`,
    fulfillmentId,
    orderLineNr,
    orderNr,
    orderId: orderNr,
    status,
    sku,
    productName: sku,
    fulfilmentBranchId: branchId,
    fulfillmentBranchId: branchId,
    branchId,
    fulfilmentStore: getStoreNameByBranchId(branchId),
    fulfillmentStore: getStoreNameByBranchId(branchId),
    multipleFulfillmentsOpen,
    createdAt,
    updatedAt
  });
}

function weborderDetailsMap(xml) {
  const map = new Map();

  getAllBlocks(xml, 'Weborder').forEach((block) => {
    const orderNr = getNodeText(block, 'OrderNr');
    if (!orderNr) return;

    const customerBlock = getNodeText(block, 'Customer');
    const items = getAllBlocks(block, 'Item').map((item) => ({
      orderLineNr: getNodeText(item, 'OrderLineNr'),
      sku: getNodeText(item, 'Sku') || getNodeText(item, 'Barcode'),
      barcode: getNodeText(item, 'Barcode') || getNodeText(item, 'Sku'),
      pieces: getNodeText(item, 'Pieces'),
      quantity: getNodeText(item, 'Pieces'),
      price: getNodeText(item, 'Price'),
      returns: getAllBlocks(item, 'Return').map((ret) => ({
        dateTime: getNodeText(ret, 'DateTime'),
        reference: getNodeText(ret, 'Reference'),
        pieces: getNodeText(ret, 'Pieces'),
        price: getNodeText(ret, 'Price')
      }))
    }));

    map.set(String(orderNr).replace(/^#/, ''), {
      orderNr: String(orderNr).replace(/^#/, ''),
      dateTime: getNodeText(block, 'DateTime'),
      customerName: getNodeText(customerBlock, 'DeliveryName'),
      customerEmail: getNodeText(customerBlock, 'Email') || getNodeText(customerBlock, 'DeliveryEmail'),
      customerPhone: getNodeText(customerBlock, 'Phone') || getNodeText(customerBlock, 'Mobile'),
      deliveryStreet: getNodeText(customerBlock, 'DeliveryAddress'),
      deliveryHouseNumber: getNodeText(customerBlock, 'DeliveryHouseNumber'),
      deliveryPostalCode: getNodeText(customerBlock, 'DeliveryPostalCode'),
      deliveryCity: getNodeText(customerBlock, 'DeliveryCity'),
      deliveryCountry: getNodeText(customerBlock, 'DeliveryCountry'),
      items
    });
  });

  return map;
}

export async function getFulfillments({ orderNr = '', branchId = '', status = '' } = {}) {
  const bodyParts = [];
  if (orderNr) bodyParts.push(`<data:OrderNr>${xmlEscape(String(orderNr).replace(/^#/, ''))}</data:OrderNr>`);
  if (branchId) bodyParts.push(`<data:BranchId>${xmlEscape(branchId)}</data:BranchId>`);
  if (status) bodyParts.push(`<data:Status>${xmlEscape(status)}</data:Status>`);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Weborders/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetFulfillments>
      ${loginXml('data')}
      <data:Body>
        ${bodyParts.join('\n')}
      </data:Body>
    </data:GetFulfillments>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetFulfillments', xml);
  const fulfillments = getAllBlocks(responseText, 'Fulfillment').map(fulfillmentFromBlock);

  return { fulfillments, raw: responseText };
}

export async function getWebordersWithDetails(orderNr) {
  const cleanOrderNr = String(orderNr || '').replace(/^#/, '').trim();
  if (!cleanOrderNr) throw new Error('SRS OrderNr ontbreekt.');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Weborders/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetWebordersWithDetails>
      ${loginXml('data')}
      <data:Body>
        <data:OrderNr>${xmlEscape(cleanOrderNr)}</data:OrderNr>
      </data:Body>
    </data:GetWebordersWithDetails>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetWebordersWithDetails', xml);
  return { detailsByOrder: weborderDetailsMap(responseText), raw: responseText };
}

export async function receiveFulfillment({ orderNr, branchId, orderLineNr = '', sku = '', fulfillmentId = '', personnelId = '', binLocation = '' }) {
  const cleanOrderNr = String(orderNr || '').replace(/^#/, '').trim();
  const cleanBranchId = String(branchId || '').trim();
  const cleanSku = String(sku || '').trim();
  const cleanOrderLineNr = String(orderLineNr || '').trim();
  const cleanFulfillmentId = String(fulfillmentId || '').trim();

  if (!cleanOrderNr) throw new Error('SRS OrderNr ontbreekt voor ReceiveFulfillment.');
  if (!cleanBranchId) throw new Error('SRS BranchId ontbreekt voor ReceiveFulfillment.');
  if (!cleanSku) throw new Error('SRS SKU ontbreekt voor ReceiveFulfillment.');
  if (!cleanOrderLineNr && !cleanFulfillmentId) throw new Error('SRS OrderLineNr of FulfillmentId ontbreekt voor ReceiveFulfillment.');

  const identifierXml = cleanOrderLineNr
    ? `<tran:OrderLineNr>${xmlEscape(cleanOrderLineNr)}</tran:OrderLineNr>`
    : `<tran:FulfillmentId>${xmlEscape(cleanFulfillmentId)}</tran:FulfillmentId>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Weborders/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:ReceiveFulfillment>
      ${transactionHeaderXml()}
      <tran:Body>
        <tran:OrderNr>${xmlEscape(cleanOrderNr)}</tran:OrderNr>
        <tran:BranchId>${xmlEscape(cleanBranchId)}</tran:BranchId>
        ${personnelId ? `<tran:PersonnelId>${xmlEscape(personnelId)}</tran:PersonnelId>` : ''}
        ${binLocation ? `<tran:BinLocation>${xmlEscape(binLocation)}</tran:BinLocation>` : ''}
        <tran:Items>
          <tran:Item>
            ${identifierXml}
            <tran:Sku>${xmlEscape(cleanSku)}</tran:Sku>
          </tran:Item>
        </tran:Items>
      </tran:Body>
    </tran:ReceiveFulfillment>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('ReceiveFulfillment', xml);
  const status = getNodeText(raw, 'Status') || 'completed';

  return {
    success: String(status).toLowerCase() === 'completed',
    status,
    orderNr: cleanOrderNr,
    branchId: cleanBranchId,
    orderLineNr: cleanOrderLineNr,
    fulfillmentId: cleanFulfillmentId,
    sku: cleanSku,
    raw
  };
}

export async function receiveFulfillments({ orderNr, branchId, items = [], personnelId = '', binLocation = '' }) {
  const results = [];
  for (const item of items || []) {
    results.push(await receiveFulfillment({
      orderNr,
      branchId: item.branchId || branchId,
      orderLineNr: item.orderLineNr || item.orderLineNumber || '',
      fulfillmentId: item.fulfillmentId || '',
      sku: item.sku || item.barcode || '',
      personnelId,
      binLocation
    }));
  }
  return {
    success: results.every((item) => item.success),
    results
  };
}

export function normalizeSrsStatus(value) {
  return String(value || '').toLowerCase().replace(/[_-]+/g, ' ').trim();
}

export function isSrsReturnableStatus(value) {
  return normalizeSrsStatus(value) === 'processed';
}

export function isSrsOpenStatus(value) {
  return ['accepted', 'pending'].includes(normalizeSrsStatus(value));
}

export function isSrsUnavailableStatus(value) {
  return ['unavailable', 'niet leverbaar', 'not available'].includes(normalizeSrsStatus(value));
}

export function isSrsCancelledStatus(value) {
  return ['cancelled', 'canceled', 'geannuleerd', 'annulled'].includes(normalizeSrsStatus(value));
}
