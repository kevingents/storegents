import { getStoreNameByBranchId } from './branch-metrics.js';
import { normalizeWeborder } from './weborder-request-store.js';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.storeinfo.nl';
const WEBORDERS_MESSAGE_PATH = '/messages/v1/soap/Weborders.php';

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

function timestamp() {
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
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: action
    },
    body: xml
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
}

function fulfillmentFromBlock(block) {
  const branchId = getNodeText(block, 'BranchId');
  const status = getNodeText(block, 'Status') || 'accepted';
  const orderNr = getNodeText(block, 'OrderNr');
  const sku = getNodeText(block, 'Sku');
  const createdAt = getNodeText(block, 'CreatedAt');
  const updatedAt = getNodeText(block, 'UpdatedAt');
  const fulfillmentId = getNodeText(block, 'FulfillmentId');
  const multipleFulfillmentsOpen = getNodeText(block, 'MultipleFulfillmentsOpen');

  return normalizeWeborder({
    source: 'srs_get_fulfillments',
    id: fulfillmentId || `${orderNr}-${sku}-${branchId}`,
    fulfillmentId,
    orderNr,
    orderId: orderNr,
    status,
    sku,
    productName: sku,
    fulfilmentBranchId: branchId,
    fulfillmentBranchId: branchId,
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
      sku: getNodeText(item, 'Sku'),
      pieces: getNodeText(item, 'Pieces'),
      price: getNodeText(item, 'Price')
    }));

    map.set(orderNr, {
      orderNr,
      dateTime: getNodeText(block, 'DateTime'),
      customerName: getNodeText(customerBlock, 'DeliveryName'),
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
  if (orderNr) bodyParts.push(`<data:OrderNr>${xmlEscape(orderNr)}</data:OrderNr>`);
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
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Weborders/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetWebordersWithDetails>
      ${loginXml('data')}
      <data:Body>
        <data:OrderNr>${xmlEscape(orderNr)}</data:OrderNr>
      </data:Body>
    </data:GetWebordersWithDetails>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetWebordersWithDetails', xml);
  return { detailsByOrder: weborderDetailsMap(responseText), raw: responseText };
}

async function enrichFulfillments(fulfillments, { maxDetails = 20 } = {}) {
  const uniqueOrders = Array.from(new Set(fulfillments.map((item) => item.orderNr).filter(Boolean))).slice(0, maxDetails);
  const details = new Map();

  for (const orderNr of uniqueOrders) {
    try {
      const result = await getWebordersWithDetails(orderNr);
      result.detailsByOrder.forEach((value, key) => details.set(key, value));
    } catch (error) {
      console.warn('GetWebordersWithDetails failed for', orderNr, error.message);
    }
  }

  return fulfillments.map((item) => {
    const detail = details.get(item.orderNr);
    if (!detail) return item;

    const line = (detail.items || []).find((row) => row.sku === item.sku) || {};
    return normalizeWeborder({
      ...item,
      productName: item.productName && item.productName !== item.sku ? item.productName : (line.sku || item.sku),
      customerName: detail.customerName || item.customerName,
      deliveryStreet: detail.deliveryStreet,
      deliveryHouseNumber: detail.deliveryHouseNumber,
      deliveryPostalCode: detail.deliveryPostalCode,
      deliveryCity: detail.deliveryCity,
      deliveryCountry: detail.deliveryCountry,
      productPrice: line.price || item.productPrice,
      quantity: line.pieces || item.quantity
    });
  });
}

export async function getOpenFulfillmentsByBranch(branchId, { includeDetails = true } = {}) {
  const statuses = ['accepted', 'pending', 'unavailable'];
  const all = [];

  for (const status of statuses) {
    try {
      const result = await getFulfillments({ branchId, status });
      all.push(...result.fulfillments);
    } catch (error) {
      // Some SRS setups may not support status filter. Try without it once below.
      if (status === statuses[0]) {
        const result = await getFulfillments({ branchId });
        all.push(...result.fulfillments.filter((item) => statuses.includes(String(item.status || '').toLowerCase())));
        break;
      }
      console.warn('GetFulfillments status failed', status, error.message);
    }
  }

  const deduped = Array.from(new Map(all.map((item) => [item.fulfillmentId || `${item.orderNr}-${item.sku}-${item.fulfilmentBranchId}`, item])).values());
  return includeDetails ? enrichFulfillments(deduped) : deduped;
}

export async function receiveFulfillment({ orderNr, branchId, orderLineNr, sku, personnelId = '', binLocation = '' }) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Weborders/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:ReceiveFulfillment>
      ${transactionHeaderXml()}
      <tran:Body>
        <tran:OrderNr>${xmlEscape(orderNr)}</tran:OrderNr>
        <tran:BranchId>${xmlEscape(branchId)}</tran:BranchId>
        ${personnelId ? `<tran:PersonnelId>${xmlEscape(personnelId)}</tran:PersonnelId>` : ''}
        ${binLocation ? `<tran:BinLocation>${xmlEscape(binLocation)}</tran:BinLocation>` : ''}
        <tran:Items>
          <tran:Item>
            <tran:OrderLineNr>${xmlEscape(orderLineNr)}</tran:OrderLineNr>
            <tran:Sku>${xmlEscape(sku)}</tran:Sku>
          </tran:Item>
        </tran:Items>
      </tran:Body>
    </tran:ReceiveFulfillment>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('ReceiveFulfillment', xml);
  return { success: true, status: getNodeText(raw, 'Status') || 'completed', raw };
}

export async function setFulfillmentBranch({ fulfillmentId, branchId }) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Weborders/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:SetFulfillments>
      ${transactionHeaderXml()}
      <tran:Body>
        <tran:Fulfillments>
          <tran:Fulfillment>
            <tran:FulfillmentId>${xmlEscape(fulfillmentId)}</tran:FulfillmentId>
            <tran:BranchId>${xmlEscape(branchId)}</tran:BranchId>
          </tran:Fulfillment>
        </tran:Fulfillments>
      </tran:Body>
    </tran:SetFulfillments>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('SetFulfillments', xml);
  return { success: true, status: getNodeText(raw, 'Status') || 'completed', raw };
}
