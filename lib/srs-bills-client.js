/**
 * SRS Webservice Bills SOAP-client.
 *
 * Methods:
 *   createBill({ customerId, billNr, amount, branchId, dateTime })
 *   getBill({ billNr })
 *   payBill({ billNr, amountPaid, paymentMethod, branchId, dateTime })
 *
 * Gebruikt door reserveringen om een "claim" op klant te leggen wanneer
 * een artikel apart wordt gehangen. Bij ophalen wordt payBill aangeroepen.
 *
 * Auth: Message user via env SRS_MESSAGE_USER + SRS_MESSAGE_PASSWORD.
 */

import crypto from 'crypto';

const DEFAULT_SRS_BASE_URL = 'https://ws.storeinfo.nl';
const BILLS_PATH = '/messages/v1/soap/Bills.php';
const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 15000);

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .trim();
}

function getSrsConfig() {
  const id = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  const baseUrl = (process.env.SRS_BASE_URL || process.env.SRS_MESSAGE_BASE_URL || DEFAULT_SRS_BASE_URL).replace(/\/$/, '');
  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER / SRS_MESSAGE_PASSWORD ontbreken in Vercel env.');
  }
  return { id, password, endpoint: `${baseUrl}${BILLS_PATH}` };
}

function getNodeText(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const match = String(xml || '').match(regex);
  return match ? decodeXml(match[1]) : '';
}

function parseSoapFault(xml) {
  const faultString = getNodeText(xml, 'faultstring') || getNodeText(xml, 'Reason') || getNodeText(xml, 'Text');
  const faultCode = getNodeText(xml, 'faultcode') || getNodeText(xml, 'Code');
  if (!faultString && !faultCode) return null;
  return { code: faultCode, message: faultString || 'SRS SOAP fault' };
}

async function postSoap(action, xml) {
  const { endpoint } = getSrsConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(SOAP_TIMEOUT_MS) && SOAP_TIMEOUT_MS > 0 ? SOAP_TIMEOUT_MS : 15000);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: action },
      body: xml,
      signal: controller.signal
    });
    const text = await response.text();
    const fault = parseSoapFault(text);
    if (!response.ok || fault) {
      const error = new Error(fault?.message || `SRS Bills fout: ${response.status}`);
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
    clearTimeout(timeout);
  }
}

function nowSrsTimestamp() {
  return new Date().toISOString().slice(0, 19); /* YYYY-MM-DDTHH:MM:SS */
}

/**
 * Genereer een unieke BillNr — SRS vereist uniek. We gebruiken een prefix
 * "RES" gevolgd door yyyymmdd + 5-cijferige random voor leesbaarheid.
 * Past binnen typische SRS bill-nr limieten (≤ 25 chars).
 */
export function generateReserveringBillNr() {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const rnd = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  return `RES${ymd}${rnd}`;
}

/**
 * Maak een nieuwe Bill aan in SRS.
 *
 * @param {object} input
 * @param {string|number} [input.customerId]  SRS klantnummer (optioneel)
 * @param {string} input.billNr               Uniek bill-nummer (max 25 chars)
 * @param {number} input.amount               Bedrag in € (decimaal, 2 cijfers)
 * @param {string|number} input.branchId      SRS branch-id
 * @param {string} [input.dateTime]           ISO timestamp (default: nu)
 * @returns {Promise<{success, status, transactionId, billNr, raw}>}
 */
export async function createBill(input) {
  const { id, password } = getSrsConfig();
  const billNr = String(input.billNr || '').trim();
  if (!billNr) throw new Error('billNr is verplicht.');
  const amount = Number(input.amount || 0);
  if (!(amount > 0)) throw new Error('amount moet > 0 zijn.');
  const branchId = String(input.branchId || '').trim();
  if (!branchId) throw new Error('branchId is verplicht.');
  const dateTime = String(input.dateTime || nowSrsTimestamp());
  const transactionId = crypto.randomUUID();
  const customerSnippet = input.customerId ? `<tran:CustomerId>${xmlEscape(input.customerId)}</tran:CustomerId>` : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Bills/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Create>
      <tran:Header>
        <com:Login>
          <com:Id>${xmlEscape(id)}</com:Id>
          <com:Password>${xmlEscape(password)}</com:Password>
        </com:Login>
        <com:TransactionId>${xmlEscape(transactionId)}</com:TransactionId>
        <com:Timestamp>${xmlEscape(nowSrsTimestamp())}</com:Timestamp>
      </tran:Header>
      <tran:Body>
        ${customerSnippet}
        <tran:BillNr>${xmlEscape(billNr)}</tran:BillNr>
        <tran:Amount>${amount.toFixed(2)}</tran:Amount>
        <tran:BranchId>${xmlEscape(branchId)}</tran:BranchId>
        <tran:DateTime>${xmlEscape(dateTime)}</tran:DateTime>
      </tran:Body>
    </tran:Create>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('Create', xml);
  const status = getNodeText(responseText, 'Status') || 'unknown';
  const responseTransactionId = getNodeText(responseText, 'TransactionId') || transactionId;
  const returnedBillNr = getNodeText(responseText, 'BillNr') || billNr;
  return {
    success: String(status).toLowerCase() === 'completed',
    status,
    transactionId: responseTransactionId,
    billNr: returnedBillNr,
    raw: responseText
  };
}

export async function getBill({ billNr } = {}) {
  const { id, password } = getSrsConfig();
  if (!billNr) throw new Error('billNr is verplicht.');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Bills/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetBill>
      <data:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </data:Login>
      <data:Body>
        <data:BillNr>${xmlEscape(billNr)}</data:BillNr>
      </data:Body>
    </data:GetBill>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetBill', xml);
  return {
    customerId: getNodeText(responseText, 'CustomerId'),
    billNr: getNodeText(responseText, 'BillNr') || billNr,
    amount: Number(getNodeText(responseText, 'Amount') || 0),
    amountPaid: Number(getNodeText(responseText, 'AmountPaid') || 0),
    paid: String(getNodeText(responseText, 'Paid') || 'false').toLowerCase() === 'true',
    branchId: getNodeText(responseText, 'BranchId'),
    dateTime: getNodeText(responseText, 'DateTime'),
    receiptNr: getNodeText(responseText, 'ReceiptNr'),
    raw: responseText
  };
}

/**
 * Markeer een bill als (deels) betaald.
 *
 * @param {object} input
 * @param {string} input.billNr
 * @param {number} input.amountPaid
 * @param {string} [input.paymentMethod]  bv. "Pin", "Contant" (moet bestaan in SRS)
 * @param {string|number} input.branchId
 * @param {string} [input.dateTime]
 */
export async function payBill(input) {
  const { id, password } = getSrsConfig();
  const billNr = String(input.billNr || '').trim();
  if (!billNr) throw new Error('billNr is verplicht.');
  const amountPaid = Number(input.amountPaid || 0);
  if (!(amountPaid > 0)) throw new Error('amountPaid moet > 0 zijn.');
  const branchId = String(input.branchId || '').trim();
  if (!branchId) throw new Error('branchId is verplicht.');
  const dateTime = String(input.dateTime || nowSrsTimestamp());
  const transactionId = crypto.randomUUID();
  const paymentSnippet = input.paymentMethod ? `<tran:PaymentMethod>${xmlEscape(input.paymentMethod)}</tran:PaymentMethod>` : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Bills/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Pay>
      <tran:Header>
        <com:Login>
          <com:Id>${xmlEscape(id)}</com:Id>
          <com:Password>${xmlEscape(password)}</com:Password>
        </com:Login>
        <com:TransactionId>${xmlEscape(transactionId)}</com:TransactionId>
        <com:Timestamp>${xmlEscape(nowSrsTimestamp())}</com:Timestamp>
      </tran:Header>
      <tran:Body>
        <tran:BillNr>${xmlEscape(billNr)}</tran:BillNr>
        <tran:AmountPaid>${amountPaid.toFixed(2)}</tran:AmountPaid>
        ${paymentSnippet}
        <tran:BranchId>${xmlEscape(branchId)}</tran:BranchId>
        <tran:DateTime>${xmlEscape(dateTime)}</tran:DateTime>
      </tran:Body>
    </tran:Pay>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('Pay', xml);
  const status = getNodeText(responseText, 'Status') || 'unknown';
  return {
    success: String(status).toLowerCase() === 'completed',
    status,
    transactionId: getNodeText(responseText, 'TransactionId') || transactionId,
    amountPaid: Number(getNodeText(responseText, 'AmountPaid') || amountPaid),
    paid: String(getNodeText(responseText, 'Paid') || 'false').toLowerCase() === 'true',
    raw: responseText
  };
}
