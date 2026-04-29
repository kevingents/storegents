import crypto from 'crypto';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.srs.nl';
const CUSTOMERS_MESSAGE_PATH = '/messages/v1/soap/Customers.php';
const SRS_CUSTOMERS_TIMEOUT_MS = Number(process.env.SRS_CUSTOMERS_TIMEOUT_MS || process.env.SRS_SOAP_TIMEOUT_MS || 15000);

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
    endpoint: `${baseUrl}${CUSTOMERS_MESSAGE_PATH}`
  };
}

function getLoginXml(prefix = 'data') {
  const { id, password } = getConfig();

  return `
    <${prefix}:Login>
      <com:Id>${xmlEscape(id)}</com:Id>
      <com:Password>${xmlEscape(password)}</com:Password>
    </${prefix}:Login>
  `;
}

function getTransactionHeaderXml(prefix = 'tran') {
  const { id, password } = getConfig();

  return `
    <${prefix}:Header>
      <com:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </com:Login>
      <com:TransactionId>${crypto.randomUUID()}</com:TransactionId>
      <com:Timestamp>${new Date().toISOString().slice(0, 19)}</com:Timestamp>
    </${prefix}:Header>
  `;
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
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    Number.isFinite(SRS_CUSTOMERS_TIMEOUT_MS) && SRS_CUSTOMERS_TIMEOUT_MS > 0 ? SRS_CUSTOMERS_TIMEOUT_MS : 15000
  );

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
      const error = new Error(fault?.message || `SRS Customers fout: ${response.status}`);
      error.status = response.status;
      error.fault = fault;
      error.responseText = text;
      throw error;
    }

    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`SRS Customers timeout na ${SRS_CUSTOMERS_TIMEOUT_MS}ms (${action}).`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function textFromFirst(block, tags) {
  for (const tag of tags) {
    const value = getNodeText(block, tag);
    if (value) return value;
  }
  return '';
}

function parseCustomer(block) {
  const nameBlock = getNodeText(block, 'Name');
  const emailBlocks = getAllBlocks(block, 'EmailAddress');
  const phoneBlocks = getAllBlocks(block, 'PhoneNumber');
  const addressBlock = getNodeText(block, 'Address');
  const receiptCountRaw = textFromFirst(block, ['ReceiptCount', 'ReceiptsCount', 'NumberOfReceipts', 'TotalReceipts']);

  const email = (
    emailBlocks
      .map((emailBlock) => String(emailBlock || '').trim())
      .find(Boolean) ||
    textFromFirst(block, ['EmailAddress'])
  );

  const phone = phoneBlocks
    .map((phoneBlock) => getNodeText(phoneBlock, 'Number'))
    .find(Boolean) || '';

  return {
    customerId: getNodeText(block, 'CustomerId'),
    createdAt: getNodeText(block, 'CreatedAt'),
    active: getNodeText(block, 'Active'),
    title: getNodeText(nameBlock, 'Title'),
    firstName: getNodeText(nameBlock, 'FirstName'),
    lastName: getNodeText(nameBlock, 'LastName'),
    displayName: [getNodeText(nameBlock, 'FirstName'), getNodeText(nameBlock, 'LastName')].filter(Boolean).join(' ') || getNodeText(nameBlock, 'Title') || '',
    gender: getNodeText(block, 'Gender'),
    birthDate: getNodeText(block, 'BirthDate'),
    registeredInBranchId: getNodeText(block, 'RegisteredInBranchId'),
    allowMailings: getNodeText(block, 'AllowMailings'),
    receivesLoyaltyPoints: getNodeText(block, 'ReceivesLoyaltyPoints'),
    email,
    receiptCount: Number.parseInt(String(receiptCountRaw || '0'), 10) || 0,
    phone,
    city: getNodeText(addressBlock, 'City'),
    postalCode: getNodeText(addressBlock, 'PostalCode'),
    raw: block
  };
}

function parseCustomers(xml) {
  const blocks = getAllBlocks(xml, 'Customer');

  return blocks
    .map(parseCustomer)
    .filter((customer) => customer.customerId);
}

function bodyFiltersXml(filters = {}) {
  const parts = [];

  if (filters.customerId) {
    parts.push(`<data:CustomerId>${xmlEscape(filters.customerId)}</data:CustomerId>`);
  }

  if (filters.cardNumber) {
    parts.push(`<data:CardNumber>${xmlEscape(filters.cardNumber)}</data:CardNumber>`);
  }

  if (filters.email) {
    parts.push(`
      <data:EmailAddresses>
        <data:EmailAddress>
          <data:EmailAddress>${xmlEscape(filters.email)}</data:EmailAddress>
        </data:EmailAddress>
      </data:EmailAddresses>
    `);
  }

  if (filters.postalCode || filters.houseNumber) {
    parts.push(`
      <data:Address>
        ${filters.houseNumber ? `<com:HouseNumber>${xmlEscape(filters.houseNumber)}</com:HouseNumber>` : ''}
        ${filters.postalCode ? `<com:PostalCode>${xmlEscape(filters.postalCode)}</com:PostalCode>` : ''}
      </data:Address>
    `);
  }

  if (filters.registeredInBranchId) {
    parts.push(`<data:RegisteredInBranchId>${xmlEscape(filters.registeredInBranchId)}</data:RegisteredInBranchId>`);
  }

  if (filters.createdFrom || filters.createdUntil) {
    parts.push(`
      <data:Created>
        ${filters.createdFrom ? `<com:From>${xmlEscape(filters.createdFrom)}</com:From>` : ''}
        ${filters.createdUntil ? `<com:Until>${xmlEscape(filters.createdUntil)}</com:Until>` : ''}
      </data:Created>
    `);
  }

  return parts.join('\n');
}

export async function getCustomers(filters = {}) {
  const body = bodyFiltersXml(filters);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Customers/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetCustomers>
      ${getLoginXml('data')}
      <data:Body>
        ${body}
      </data:Body>
    </data:GetCustomers>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetCustomers', xml);

  return {
    customers: parseCustomers(responseText),
    raw: responseText
  };
}

export async function getCustomersByBranchAndPeriod({ branchId, dateFrom, dateTo }) {
  const filters = {
    registeredInBranchId: branchId || '',
    createdFrom: dateFrom ? `${dateFrom}T00:00:00` : '',
    createdUntil: dateTo ? `${dateTo}T23:59:59` : ''
  };

  const result = await getCustomers(filters);

  const customers = result.customers.filter((customer) => {
    if (!customer.createdAt) return true;
    const createdDate = customer.createdAt.slice(0, 10);

    if (dateFrom && createdDate < dateFrom) return false;
    if (dateTo && createdDate > dateTo) return false;
    if (branchId && String(customer.registeredInBranchId) !== String(branchId)) return false;

    return true;
  });

  return {
    ...result,
    customers
  };
}

export async function createCustomer(customer) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Customers/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:cus="https://messages.storeinfo.nl/v1/Customers">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Create>
      ${getTransactionHeaderXml('tran')}
      <tran:Body>
        <tran:Customers>
          <tran:Customer>
            <cus:Name>
              ${customer.title ? `<cus:Title>${xmlEscape(customer.title)}</cus:Title>` : ''}
              ${customer.firstName ? `<cus:FirstName>${xmlEscape(customer.firstName)}</cus:FirstName>` : ''}
              ${customer.lastName ? `<cus:LastName>${xmlEscape(customer.lastName)}</cus:LastName>` : ''}
            </cus:Name>
            ${customer.gender ? `<cus:Gender>${xmlEscape(customer.gender)}</cus:Gender>` : ''}
            ${customer.birthDate ? `<cus:BirthDate>${xmlEscape(customer.birthDate)}</cus:BirthDate>` : ''}
            ${customer.registeredInBranchId ? `<cus:RegisteredInBranchId>${xmlEscape(customer.registeredInBranchId)}</cus:RegisteredInBranchId>` : ''}
            <cus:AllowMailings>${customer.allowMailings ? 'true' : 'false'}</cus:AllowMailings>
            <cus:ReceivesLoyaltyPoints>${customer.receivesLoyaltyPoints !== false ? 'true' : 'false'}</cus:ReceivesLoyaltyPoints>
            ${customer.email ? `
            <cus:EmailAddresses>
              <cus:EmailAddress>
                <cus:Type>0</cus:Type>
                <cus:EmailAddress>${xmlEscape(customer.email)}</cus:EmailAddress>
              </cus:EmailAddress>
            </cus:EmailAddresses>` : ''}
          </tran:Customer>
        </tran:Customers>
      </tran:Body>
    </tran:Create>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('Create', xml);

  return {
    customers: parseCustomers(responseText),
    status: getNodeText(responseText, 'Status'),
    raw: responseText
  };
}
