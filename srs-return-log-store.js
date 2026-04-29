import crypto from 'crypto';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.srs.nl';
const VOUCHERS_MESSAGE_PATH = '/messages/v1/soap/Vouchers.php';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getConfig() {
  const id = process.env.SRS_MESSAGE_USER || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || '';
  const baseUrl = (process.env.SRS_MESSAGE_BASE_URL || process.env.SRS_BASE_URL || DEFAULT_SRS_MESSAGE_BASE_URL).replace(/\/$/, '');

  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken.');
  }

  return {
    id,
    password,
    endpoint: `${baseUrl}${VOUCHERS_MESSAGE_PATH}`
  };
}

function timestamp() {
  return new Date().toISOString().slice(0, 19);
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

  return {
    code: faultCode,
    message: faultString || 'SRS SOAP fault'
  };
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
    const error = new Error(fault?.message || `SRS Vouchers fout: ${response.status}`);
    error.status = response.status;
    error.fault = fault;
    error.responseText = text;
    throw error;
  }

  return text;
}

function headerXml(transactionId) {
  const { id, password } = getConfig();

  return `
    <tran:Header>
      <com:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </com:Login>
      <com:TransactionId>${xmlEscape(transactionId)}</com:TransactionId>
      <com:Timestamp>${xmlEscape(timestamp())}</com:Timestamp>
    </tran:Header>
  `;
}

function parseStatus(xml) {
  const headerBlock = getNodeText(xml, 'Header');
  const transactionId = getNodeText(headerBlock, 'TransactionId') || getNodeText(xml, 'TransactionId');
  const status = getNodeText(headerBlock, 'Status') || getNodeText(xml, 'Status');

  const voucherBlocks = getAllBlocks(xml, 'Voucher');
  const vouchers = voucherBlocks.map((block) => ({
    id: getNodeText(block, 'Id'),
    voucherCode: getNodeText(block, 'Id'),
    validFrom: getNodeText(getNodeText(block, 'Valid'), 'From') || getNodeText(block, 'From'),
    validTo: getNodeText(getNodeText(block, 'Valid'), 'Until') || getNodeText(block, 'Until'),
    value: Number(getNodeText(block, 'Value') || 0),
    customerId: getNodeText(block, 'CustomerId')
  })).filter((voucher) => voucher.id);

  return {
    transactionId,
    status: String(status || '').toLowerCase(),
    vouchers,
    raw: xml
  };
}

function customersXml(customerIds = []) {
  if (!Array.isArray(customerIds) || !customerIds.length) {
    return '<tran:Customers/>';
  }

  return `
    <tran:Customers>
      ${customerIds.map((id) => `<tran:CustomerId>${xmlEscape(id)}</tran:CustomerId>`).join('\n')}
    </tran:Customers>
  `;
}

export function getLoyaltyVoucherRules() {
  const stepsOf = String(process.env.LOYALTY_VOUCHER_STEPS_OF || '1.00').replace(',', '.');
  const minimum = String(process.env.LOYALTY_VOUCHER_MINIMUM || process.env.VOUCHER_MIN_AMOUNT_EUR || '25.00').replace(',', '.');
  const maximum = String(process.env.LOYALTY_VOUCHER_MAXIMUM || '250.00').replace(',', '.');
  const validityMonths = Number(process.env.VOUCHER_VALIDITY_MONTHS || 3) || 3;

  return {
    stepsOf,
    minimum,
    maximum,
    validityMonths
  };
}

export function getDefaultValidity() {
  const validityMonths = Number(process.env.VOUCHER_VALIDITY_MONTHS || 3) || 3;
  const from = new Date();
  const until = new Date();
  until.setMonth(until.getMonth() + validityMonths);

  return {
    validFrom: from.toISOString().slice(0, 10),
    validTo: until.toISOString().slice(0, 10)
  };
}

export async function createVouchersFromLoyaltyPoints({
  reference,
  validFrom,
  validTo,
  stepsOf,
  minimum,
  maximum,
  customerIds = []
} = {}) {
  const transactionId = crypto.randomUUID();
  const rules = getLoyaltyVoucherRules();
  const validity = getDefaultValidity();

  const finalReference = reference || `GENTS-loyalty-${new Date().toISOString().slice(0, 10)}`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Vouchers/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:CreateFromLoyaltyPoints>
      ${headerXml(transactionId)}
      <tran:Body>
        <tran:Reference>${xmlEscape(finalReference)}</tran:Reference>
        <tran:Valid>
          <tran:From>${xmlEscape(validFrom || validity.validFrom)}</tran:From>
          <tran:Until>${xmlEscape(validTo || validity.validTo)}</tran:Until>
        </tran:Valid>
        <tran:Value>
          <tran:StepsOf>${xmlEscape(stepsOf || rules.stepsOf)}</tran:StepsOf>
          <tran:Minimum>${xmlEscape(minimum || rules.minimum)}</tran:Minimum>
          <tran:Maximum>${xmlEscape(maximum || rules.maximum)}</tran:Maximum>
        </tran:Value>
        ${customersXml(customerIds)}
      </tran:Body>
    </tran:CreateFromLoyaltyPoints>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('CreateFromLoyaltyPoints', xml);

  return {
    ...parseStatus(responseText),
    transactionId,
    reference: finalReference,
    request: {
      validFrom: validFrom || validity.validFrom,
      validTo: validTo || validity.validTo,
      stepsOf: stepsOf || rules.stepsOf,
      minimum: minimum || rules.minimum,
      maximum: maximum || rules.maximum,
      customerIds
    }
  };
}

export async function getVouchersTransactionStatus(transactionId) {
  if (!transactionId) {
    throw new Error('TransactionId ontbreekt.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Vouchers/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:GetStatus>
      ${headerXml(transactionId)}
      <tran:Body>
        <tran:TransactionId>${xmlEscape(transactionId)}</tran:TransactionId>
      </tran:Body>
    </tran:GetStatus>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetStatus', xml);
  return parseStatus(responseText);
}

export async function createAndPollVouchersFromLoyaltyPoints(options = {}) {
  const created = await createVouchersFromLoyaltyPoints(options);

  if (created.status === 'completed') {
    return created;
  }

  const attempts = Number(options.pollAttempts || process.env.LOYALTY_VOUCHER_POLL_ATTEMPTS || 4);
  const delayMs = Number(options.pollDelayMs || process.env.LOYALTY_VOUCHER_POLL_DELAY_MS || 2500);

  let latest = created;

  for (let i = 0; i < attempts; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    latest = await getVouchersTransactionStatus(created.transactionId);

    if (latest.status === 'completed') {
      return {
        ...latest,
        transactionId: latest.transactionId || created.transactionId,
        reference: created.reference,
        request: created.request
      };
    }
  }

  return {
    ...latest,
    transactionId: latest.transactionId || created.transactionId,
    reference: created.reference,
    request: created.request
  };
}
