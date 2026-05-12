import crypto from 'crypto';

const BASE = 'https://production.storeinfo.nl';
const PATH = '/messages/v1/soap/Vouchers.php';
const SOAP = 'https://messages.storeinfo.nl/v1/soap/Vouchers';
const SRS_AMOUNT = '2500';
const EURO_AMOUNT = 25;

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function cfg() {
  const id = process.env.SRS_MESSAGE_USER || '';
  const pwKey = ['SRS_MESSAGE', 'PASSWORD'].join('_');
  const pw = process.env[pwKey] || '';
  const baseUrl = (process.env.SRS_MESSAGE_BASE_URL || process.env.SRS_BASE_URL || BASE).replace(/\/$/, '');
  if (!id || !pw) throw new Error('SRS Message login ontbreekt.');
  return { id, pw, endpoint: `${baseUrl}${PATH}` };
}

function text(xml, tag) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tag}>`, 'i');
  return String(xml || '').match(re)?.[1]?.trim() || '';
}

function blocks(xml, tag) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tag}>`, 'gi');
  return Array.from(String(xml || '').matchAll(re)).map((m) => m[1]);
}

function fault(xml) {
  const message = text(xml, 'faultstring') || text(xml, 'Reason') || text(xml, 'Text');
  const code = text(xml, 'faultcode') || text(xml, 'Code');
  return message || code ? { code, message: message || 'SRS SOAP fault' } : null;
}

async function post(action, xml) {
  const { endpoint } = cfg();
  const soapAction = `${SOAP}/${action}`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Accept: 'text/xml, application/xml, application/soap+xml, */*', 'Content-Type': 'text/xml; charset=utf-8', SOAPAction: soapAction },
    body: xml
  });
  const body = await res.text();
  const problem = fault(body);
  if (!res.ok || problem) {
    const error = new Error(problem?.message || `SRS Vouchers fout: ${res.status}`);
    error.status = res.status;
    error.fault = problem;
    error.responseText = body;
    throw error;
  }
  return body;
}

function loginXml(transactionId, wrap = 'tran') {
  const { id, pw } = cfg();
  const pwTag = 'Password';
  const core = `<com:Login><com:Id>${esc(id)}</com:Id><com:${pwTag}>${esc(pw)}</com:${pwTag}></com:Login><com:TransactionId>${esc(transactionId)}</com:TransactionId>`;
  if (wrap === 'common') return core;
  return `<tran:Header>${core}<com:Timestamp>${esc(new Date().toISOString().slice(0, 19))}</com:Timestamp></tran:Header>`;
}

function parse(xml) {
  const header = text(xml, 'Header');
  const transactionId = text(header, 'TransactionId') || text(xml, 'TransactionId');
  const status = text(header, 'Status') || text(xml, 'Status');
  const vouchers = blocks(xml, 'Voucher').map((block) => {
    const raw = text(block, 'Value') || '0';
    return {
      id: text(block, 'Id'),
      voucherCode: text(block, 'Id'),
      validFrom: text(text(block, 'Valid'), 'From') || text(block, 'From'),
      validTo: text(text(block, 'Valid'), 'Until') || text(block, 'Until'),
      value: (Number(String(raw).replace(',', '.')) || 0) / 100,
      srsRawValue: raw,
      customerId: text(block, 'CustomerId')
    };
  }).filter((v) => v.id);
  return { transactionId, status: String(status || '').toLowerCase(), vouchers, raw: xml };
}

function customersXml(ids = []) {
  return ids.length ? `<tran:Customers>${ids.map((id) => `<tran:CustomerId>${esc(id)}</tran:CustomerId>`).join('')}</tran:Customers>` : '<tran:Customers/>';
}

export function getLoyaltyVoucherRules() {
  const validityMonths = Number(process.env.VOUCHER_VALIDITY_MONTHS || 3) || 3;
  return { stepsOf: SRS_AMOUNT, minimum: SRS_AMOUNT, maximum: SRS_AMOUNT, displayAmount: EURO_AMOUNT, validityMonths };
}

export function getDefaultValidity() {
  const validityMonths = Number(process.env.VOUCHER_VALIDITY_MONTHS || 3) || 3;
  const from = new Date();
  const until = new Date();
  until.setMonth(until.getMonth() + validityMonths);
  return { validFrom: from.toISOString().slice(0, 10), validTo: until.toISOString().slice(0, 10) };
}

export async function createVouchersFromLoyaltyPoints({ reference, validFrom, validTo, customerIds = [] } = {}) {
  const transactionId = crypto.randomUUID();
  const validity = getDefaultValidity();
  const finalReference = reference || `GENTS-loyalty-${new Date().toISOString().slice(0, 10)}`;
  const from = validFrom || validity.validFrom;
  const to = validTo || validity.validTo;
  const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Vouchers/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common"><soapenv:Header/><soapenv:Body><tran:CreateFromLoyaltyPoints>${loginXml(transactionId)}<tran:Body><tran:Reference>${esc(finalReference)}</tran:Reference><tran:Valid><tran:From>${esc(from)}</tran:From><tran:Until>${esc(to)}</tran:Until></tran:Valid><tran:Value><tran:StepsOf>${SRS_AMOUNT}</tran:StepsOf><tran:Minimum>${SRS_AMOUNT}</tran:Minimum><tran:Maximum>${SRS_AMOUNT}</tran:Maximum></tran:Value>${customersXml(customerIds)}</tran:Body></tran:CreateFromLoyaltyPoints></soapenv:Body></soapenv:Envelope>`;
  return { ...parse(await post('CreateFromLoyaltyPoints', xml)), transactionId, reference: finalReference, request: { validFrom: from, validTo: to, stepsOf: SRS_AMOUNT, minimum: SRS_AMOUNT, maximum: SRS_AMOUNT, displayAmount: EURO_AMOUNT, customerIds } };
}

export async function getVouchersTransactionStatus(transactionId) {
  if (!transactionId) throw new Error('TransactionId ontbreekt.');
  const xml = `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:com="https://messages.storeinfo.nl/v1/Common"><soapenv:Header/><soapenv:Body><com:GetStatus>${loginXml(transactionId, 'common')}</com:GetStatus></soapenv:Body></soapenv:Envelope>`;
  return parse(await post('GetStatus', xml));
}

export async function createAndPollVouchersFromLoyaltyPoints(options = {}) {
  const created = await createVouchersFromLoyaltyPoints(options);
  if (created.status === 'completed') return created;
  const attempts = Number(options.pollAttempts || process.env.LOYALTY_VOUCHER_POLL_ATTEMPTS || 4);
  const delayMs = Number(options.pollDelayMs || process.env.LOYALTY_VOUCHER_POLL_DELAY_MS || 2500);
  let latest = created;
  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    latest = await getVouchersTransactionStatus(created.transactionId);
    if (latest.status === 'completed') return { ...latest, transactionId: latest.transactionId || created.transactionId, reference: created.reference, request: created.request };
  }
  return { ...latest, transactionId: latest.transactionId || created.transactionId, reference: created.reference, request: created.request };
}
