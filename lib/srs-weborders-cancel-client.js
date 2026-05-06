import crypto from 'crypto';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.storeinfo.nl';
const WEBORDERS_MESSAGE_PATH = '/messages/v1/soap/Weborders.php';
const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 20000);

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
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
  const baseUrl = (
    process.env.SRS_MESSAGE_BASE_URL ||
    process.env.SRS_BASE_URL ||
    DEFAULT_SRS_MESSAGE_BASE_URL
  ).replace(/\/$/, '');

  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken.');
  }

  return {
    id,
    password,
    endpoint: `${baseUrl}${WEBORDERS_MESSAGE_PATH}`
  };
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
  const regex = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`,
    'i'
  );
  const match = String(xml || '').match(regex);
  return match ? match[1].trim() : '';
}

function parseSoapFault(xml) {
  const faultString = getNodeText(xml, 'faultstring') || getNodeText(xml, 'Reason') || getNodeText(xml, 'Text');
  const faultCode = getNodeText(xml, 'faultcode') || getNodeText(xml, 'Code');

  if (!faultString && !faultCode) return null;

  return {
    code: faultCode,
    message: faultString || 'SRS SOAP fault'
  };
}

async function postSoap(action, xml) {
  const { endpoint } = getConfig();
  const controller = new AbortController();
  const timeout = Number.isFinite(SOAP_TIMEOUT_MS) && SOAP_TIMEOUT_MS > 0 ? SOAP_TIMEOUT_MS : 20000;
  const timer = setTimeout(() => controller.abort(), timeout);

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
      const timeoutError = new Error(`SRS timeout na ${timeout}ms (${action}).`);
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeNumber(value, fallback = 0) {
  const parsed = Number(String(value ?? '').replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildIdentifierXml({ fulfillmentId = '', orderLineNr = '' } = {}) {
  const cleanFulfillmentId = String(fulfillmentId || '').trim();
  const cleanOrderLineNr = String(orderLineNr || '').trim();

  if (cleanFulfillmentId) {
    return `<web:FulfillmentId>${xmlEscape(cleanFulfillmentId)}</web:FulfillmentId>`;
  }

  if (cleanOrderLineNr) {
    return `<web:OrderLineNr>${xmlEscape(cleanOrderLineNr)}</web:OrderLineNr>`;
  }

  throw new Error('SRS FulfillmentId of OrderLineNr ontbreekt voor Cancel.');
}

export async function cancelFulfillment({
  orderNr,
  fulfillmentId = '',
  orderLineNr = '',
  sku = '',
  barcode = '',
  pieces = 1,
  price = 0,
  dateTime = ''
} = {}) {
  const cleanOrderNr = String(orderNr || '').replace(/^#/, '').trim();
  const cleanSku = String(sku || barcode || '').trim();
  const cleanPieces = Math.max(1, normalizeNumber(pieces, 1));
  const cleanPrice = Math.max(0, normalizeNumber(price, 0));
  const cancelDateTime = timestamp(dateTime);

  if (!cleanOrderNr) {
    throw new Error('SRS OrderNr ontbreekt voor Cancel.');
  }

  if (!cleanSku) {
    throw new Error('SRS SKU/barcode ontbreekt voor Cancel.');
  }

  const identifierXml = buildIdentifierXml({ fulfillmentId, orderLineNr });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Weborders/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:web="https://messages.storeinfo.nl/v1/Weborders">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Cancel>
      ${transactionHeaderXml()}
      <tran:Body>
        <tran:OrderNr>${xmlEscape(cleanOrderNr)}</tran:OrderNr>
        <tran:DateTime>${xmlEscape(cancelDateTime)}</tran:DateTime>
        <tran:Items>
          <web:Item>
            ${identifierXml}
            <web:Sku>${xmlEscape(cleanSku)}</web:Sku>
            <web:Pieces>${xmlEscape(cleanPieces)}</web:Pieces>
            <web:Price>${xmlEscape(cleanPrice.toFixed(2))}</web:Price>
          </web:Item>
        </tran:Items>
      </tran:Body>
    </tran:Cancel>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('Cancel', xml);
  const status = getNodeText(raw, 'Status') || 'completed';
  const transactionId = getNodeText(raw, 'TransactionId');

  return {
    success: String(status).toLowerCase() === 'completed',
    status,
    transactionId,
    orderNr: cleanOrderNr,
    fulfillmentId: String(fulfillmentId || '').trim(),
    orderLineNr: String(orderLineNr || '').trim(),
    sku: cleanSku,
    pieces: cleanPieces,
    price: cleanPrice,
    dateTime: cancelDateTime,
    raw
  };
}
