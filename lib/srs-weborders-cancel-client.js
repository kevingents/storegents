import crypto from 'crypto';
import { getFulfillments, isSrsCancelledStatus, isSrsUnavailableStatus } from './srs-weborders-message-client.js';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.storeinfo.nl';
const WEBORDERS_MESSAGE_PATH = '/messages/v1/soap/Weborders.php';
const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 20000);
const CANCEL_ACTIONS = ['Cancel'];

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

function getAllNodeTexts(xml, tagName) {
  const regex = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`,
    'gi'
  );
  return Array.from(String(xml || '').matchAll(regex)).map((match) => match[1].trim());
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

function clean(value) {
  return String(value || '').trim();
}

function normalizeStatus(value) {
  return clean(value).toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
}

function buildIdentifierXml({ fulfillmentId = '', orderLineNr = '' } = {}) {
  const cleanFulfillmentId = clean(fulfillmentId);
  const cleanOrderLineNr = clean(orderLineNr);

  if (cleanFulfillmentId) {
    return `<web:FulfillmentId>${xmlEscape(cleanFulfillmentId)}</web:FulfillmentId>`;
  }

  if (cleanOrderLineNr) {
    return `<web:OrderLineNr>${xmlEscape(cleanOrderLineNr)}</web:OrderLineNr>`;
  }

  throw new Error('SRS FulfillmentId of OrderLineNr ontbreekt voor Cancel.');
}

function isCompletedStatus(value) {
  const status = normalizeStatus(value);
  return status === 'completed' || status === 'complete' || status === 'ok' || status === 'success' || status === 'processed';
}

function buildCancelXml({ action, orderNr, fulfillmentId, orderLineNr, sku, pieces, price, dateTime }) {
  const identifierXml = buildIdentifierXml({ fulfillmentId, orderLineNr });

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Weborders/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:web="https://messages.storeinfo.nl/v1/Weborders">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:${action}>
      ${transactionHeaderXml()}
      <tran:Body>
        <tran:OrderNr>${xmlEscape(orderNr)}</tran:OrderNr>
        <tran:DateTime>${xmlEscape(dateTime)}</tran:DateTime>
        <tran:Items>
          <web:Item>
            ${identifierXml}
            <web:Sku>${xmlEscape(sku)}</web:Sku>
            <web:Pieces>${xmlEscape(pieces)}</web:Pieces>
            <web:Price>${xmlEscape(price.toFixed(2))}</web:Price>
          </web:Item>
        </tran:Items>
      </tran:Body>
    </tran:${action}>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function parseCancelResponse({ raw, action, orderNr, fulfillmentId, orderLineNr, sku, pieces, price, dateTime }) {
  const statuses = getAllNodeTexts(raw, 'Status');
  const status = statuses.find(isCompletedStatus) || statuses.find(Boolean) || 'completed';
  const transactionId = getNodeText(raw, 'TransactionId');
  const messages = getAllNodeTexts(raw, 'Message').concat(getAllNodeTexts(raw, 'Error')).filter(Boolean);
  const responseSuccess = statuses.length ? statuses.some(isCompletedStatus) : isCompletedStatus(status);

  return {
    success: responseSuccess,
    responseSuccess,
    action,
    status,
    statuses,
    messages,
    transactionId,
    orderNr,
    fulfillmentId: clean(fulfillmentId),
    orderLineNr: clean(orderLineNr),
    sku,
    pieces,
    price,
    dateTime,
    raw
  };
}

function sameLine(row = {}, { fulfillmentId = '', orderLineNr = '', sku = '' } = {}) {
  const rowFulfillmentId = clean(row.fulfillmentId);
  const rowOrderLineNr = clean(row.orderLineNr);
  const rowSku = clean(row.sku || row.barcode);
  const targetFulfillmentId = clean(fulfillmentId);
  const targetOrderLineNr = clean(orderLineNr);
  const targetSku = clean(sku);

  if (targetFulfillmentId && rowFulfillmentId && rowFulfillmentId === targetFulfillmentId) return true;
  if (targetOrderLineNr && rowOrderLineNr && rowOrderLineNr === targetOrderLineNr && (!targetSku || !rowSku || rowSku === targetSku)) return true;
  if (targetSku && rowSku && rowSku === targetSku && (!targetOrderLineNr || !rowOrderLineNr || rowOrderLineNr === targetOrderLineNr)) return true;

  return false;
}

function rowSummary(row = {}) {
  return {
    id: row.id,
    orderNr: row.orderNr,
    fulfillmentId: row.fulfillmentId,
    orderLineNr: row.orderLineNr,
    sku: row.sku || row.barcode,
    status: row.status,
    normalizedStatus: normalizeStatus(row.status),
    isUnavailable: isSrsUnavailableStatus(row.status),
    isCancelled: isSrsCancelledStatus(row.status)
  };
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyCancelOnce({ orderNr, fulfillmentId, orderLineNr, sku } = {}) {
  const result = await getFulfillments({ orderNr });
  const rows = result.fulfillments || [];
  const matchingRows = rows.filter((row) => sameLine(row, { fulfillmentId, orderLineNr, sku }));
  const statuses = matchingRows.map((row) => row.status).filter(Boolean);
  const stillUnavailable = matchingRows.some((row) => isSrsUnavailableStatus(row.status));
  const cancelled = matchingRows.some((row) => isSrsCancelledStatus(row.status));

  return {
    success: matchingRows.length > 0 && cancelled && !stillUnavailable,
    cancelled,
    stillUnavailable,
    foundMatchingLine: matchingRows.length > 0,
    statuses,
    matchingRows: matchingRows.map(rowSummary),
    allRows: rows.map(rowSummary),
    raw: result.raw
  };
}

async function verifyCancel(options = {}) {
  const checks = [];

  for (const delayMs of [0, 750, 2500]) {
    if (delayMs) await sleep(delayMs);

    try {
      const check = await verifyCancelOnce(options);
      checks.push({ delayMs, ...check });
      if (check.success) return { ...check, checks };
    } catch (error) {
      checks.push({ delayMs, success: false, verifyError: error.message || 'SRS verificatie mislukt.' });
    }
  }

  const last = checks[checks.length - 1] || { success: false, verifyError: 'SRS verificatie mislukt.' };
  return { ...last, success: false, checks };
}

async function attemptCancel(action, options) {
  const xml = buildCancelXml({ action, ...options });
  const raw = await postSoap(action, xml);
  return parseCancelResponse({ raw, action, ...options });
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
  const cleanOrderNr = clean(orderNr).replace(/^#/, '');
  const cleanSku = clean(sku || barcode);
  const cleanPieces = Math.max(1, normalizeNumber(pieces, 1));
  const cleanPrice = Math.max(0, normalizeNumber(price, 0));
  const cancelDateTime = timestamp(dateTime);

  if (!cleanOrderNr) throw new Error('SRS OrderNr ontbreekt voor Cancel.');
  if (!cleanSku) throw new Error('SRS SKU/barcode ontbreekt voor Cancel.');

  const options = {
    orderNr: cleanOrderNr,
    fulfillmentId,
    orderLineNr,
    sku: cleanSku,
    pieces: cleanPieces,
    price: cleanPrice,
    dateTime: cancelDateTime
  };

  const attempts = [];
  const errors = [];

  for (const action of CANCEL_ACTIONS) {
    try {
      const attempt = await attemptCancel(action, options);
      attempt.verification = await verifyCancel(options);
      attempt.success = Boolean(attempt.responseSuccess && attempt.verification?.success);
      attempts.push(attempt);

      if (attempt.success) {
        return {
          ...attempt,
          attempts
        };
      }
    } catch (error) {
      errors.push({
        action,
        message: error.message || String(error),
        status: error.status || null,
        fault: error.fault || null,
        responseText: error.responseText || ''
      });
    }
  }

  const best = attempts[0] || null;
  const lastVerification = attempts.map((attempt) => attempt.verification).filter(Boolean).pop() || best?.verification || null;
  const stillUnavailable = attempts.some((attempt) => attempt.verification?.stillUnavailable);
  const notFound = attempts.some((attempt) => attempt.verification && !attempt.verification.foundMatchingLine);
  const message = stillUnavailable
    ? 'SRS accepteerde de cancel-call, maar dezelfde orderregel staat na verificatie nog op niet leverbaar.'
    : notFound
      ? 'SRS accepteerde de cancel-call, maar verificatie vond dezelfde orderregel niet terug. Niet als verwerkt gemarkeerd.'
      : (errors[0]?.message || 'SRS cancel is niet bevestigd.');

  return {
    success: false,
    responseSuccess: Boolean(best?.responseSuccess),
    status: best?.status || 'not_confirmed',
    statuses: best?.statuses || [],
    messages: [...(best?.messages || []), message],
    transactionId: best?.transactionId || '',
    orderNr: cleanOrderNr,
    fulfillmentId: clean(fulfillmentId),
    orderLineNr: clean(orderLineNr),
    sku: cleanSku,
    pieces: cleanPieces,
    price: cleanPrice,
    dateTime: cancelDateTime,
    verification: lastVerification,
    attempts,
    errors,
    raw: best?.raw || ''
  };
}
