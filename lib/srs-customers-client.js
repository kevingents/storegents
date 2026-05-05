import crypto from 'crypto';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.storeinfo.nl';
const CUSTOMERS_MESSAGE_PATH = '/messages/v1/soap/Customers.php';
const SRS_CUSTOMERS_TIMEOUT_MS = Number(process.env.SRS_CUSTOMERS_TIMEOUT_MS || process.env.SRS_SOAP_TIMEOUT_MS || 45000);

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getConfig() {
  const id = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  const baseUrl = (process.env.SRS_BASE_URL || DEFAULT_SRS_MESSAGE_BASE_URL).replace(/\/$/, '');
  if (!id || !password) throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken.');
  return { id, password, endpoint: `${baseUrl}${CUSTOMERS_MESSAGE_PATH}` };
}

function getLoginXml(prefix = 'data') {
  const { id, password } = getConfig();
  return `<${prefix}:Login><com:Id>${xmlEscape(id)}</com:Id><com:Password>${xmlEscape(password)}</com:Password></${prefix}:Login>`;
}

function getTransactionHeaderXml(prefix = 'tran') {
  const { id, password } = getConfig();
  return `<${prefix}:Header><com:Login><com:Id>${xmlEscape(id)}</com:Id><com:Password>${xmlEscape(password)}</com:Password></com:Login><com:TransactionId>${crypto.randomUUID()}</com:TransactionId><com:Timestamp>${new Date().toISOString().slice(0, 19)}</com:Timestamp></${prefix}:Header>`;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getNodeText(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const match = String(xml || '').match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getAllBlocks(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'gi');
  return Array.from(String(xml || '').matchAll(regex)).map((match) => match[1]);
}

function parseSoapFault(xml) {
  const faultString = getNodeText(xml, 'faultstring') || getNodeText(xml, 'Reason') || getNodeText(xml, 'Text');
  const faultCode = getNodeText(xml, 'faultcode') || getNodeText(xml, 'Code');
  return faultString ? { code: faultCode, message: faultString } : null;
}

async function postSoap(action, xml) {
  const { endpoint } = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SRS_CUSTOMERS_TIMEOUT_MS);

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
      const error = new Error(fault?.message || `SRS Customers fout: ${response.status}`);
      error.status = response.status;
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
  const nameBlock = getNodeText(block, 'Name') || block;
  const emailBlocks = getAllBlocks(block, 'EmailAddress');
  const phoneBlocks = getAllBlocks(block, 'PhoneNumber');
  const addressBlock = getNodeText(block, 'Address');
  const email = emailBlocks.map((b) => getNodeText(b, 'EmailAddress') || b.trim()).find((v) => String(v).includes('@')) || textFromFirst(block, ['EmailAddress', 'Email']);
  const phone = phoneBlocks.map((b) => getNodeText(b, 'Number')).find(Boolean) || '';
  const firstName = getNodeText(nameBlock, 'FirstName');
  const lastName = getNodeText(nameBlock, 'LastName');
  const title = getNodeText(nameBlock, 'Title');
  const receiptCountRaw = textFromFirst(block, ['ReceiptCount', 'ReceiptsCount', 'NumberOfReceipts', 'TotalReceipts']);

  return {
    customerId: textFromFirst(block, ['CustomerId', 'CustomerID']),
    loyaltyCardId: textFromFirst(block, ['LoyaltyCardId', 'CardId']),
    createdAt: textFromFirst(block, ['CreatedAt', 'Created']),
    updatedAt: textFromFirst(block, ['UpdatedAt', 'Updated']),
    active: getNodeText(block, 'Active'),
    title,
    firstName,
    lastName,
    name: [title, firstName, lastName].filter(Boolean).join(' ').trim() || title || '',
    gender: getNodeText(block, 'Gender'),
    birthDate: getNodeText(block, 'BirthDate'),
    registeredInBranchId: getNodeText(block, 'RegisteredInBranchId'),
    allowMailings: getNodeText(block, 'AllowMailings'),
    receivesLoyaltyPoints: getNodeText(block, 'ReceivesLoyaltyPoints'),
    email,
    phone,
    city: getNodeText(addressBlock, 'City'),
    postalCode: getNodeText(addressBlock, 'PostalCode'),
    address1: getNodeText(addressBlock, 'Address1'),
    houseNumber: getNodeText(addressBlock, 'HouseNumber'),
    receiptCount: Number.parseInt(String(receiptCountRaw || '0'), 10) || 0
  };
}

function parseCustomers(xml) {
  return getAllBlocks(xml, 'Customer').map(parseCustomer).filter((c) => c.customerId || c.email || c.name);
}

function bodyFiltersXml(filters = {}) {
  const parts = [];

  // Let op: volgens SRS GetCustomers XSD is RegisteredInBranchId GEEN geldig filter.
  // Dat veld mag wel in Create en response staan, maar niet in GetCustomers/Body.
  // Rapportages halen daarom op Created periode op en groeperen daarna lokaal per registeredInBranchId.
  if (filters.customerId) parts.push(`<data:CustomerId>${xmlEscape(filters.customerId)}</data:CustomerId>`);
  if (filters.loyaltyCardId) parts.push(`<data:LoyaltyCardId>${xmlEscape(filters.loyaltyCardId)}</data:LoyaltyCardId>`);
  if (filters.email) parts.push(`<data:EmailAddress>${xmlEscape(filters.email)}</data:EmailAddress>`);
  if (filters.phone) parts.push(`<data:PhoneNumber>${xmlEscape(filters.phone)}</data:PhoneNumber>`);

  if (filters.postalCode || filters.houseNumber) {
    parts.push(`<data:Address>${filters.houseNumber ? `<com:HouseNumber>${xmlEscape(filters.houseNumber)}</com:HouseNumber>` : ''}${filters.postalCode ? `<com:PostalCode>${xmlEscape(filters.postalCode)}</com:PostalCode>` : ''}</data:Address>`);
  }

  if (filters.createdFrom || filters.createdUntil) {
    parts.push(`<data:Created>${filters.createdFrom ? `<com:From>${xmlEscape(filters.createdFrom)}</com:From>` : ''}${filters.createdUntil ? `<com:Until>${xmlEscape(filters.createdUntil)}</com:Until>` : ''}</data:Created>`);
  }

  if (filters.updatedFrom || filters.updatedUntil) {
    parts.push(`<data:Updated>${filters.updatedFrom ? `<com:From>${xmlEscape(filters.updatedFrom)}</com:From>` : ''}${filters.updatedUntil ? `<com:Until>${xmlEscape(filters.updatedUntil)}</com:Until>` : ''}</data:Updated>`);
  }

  return parts.join('\n');
}

export async function getCustomers(filters = {}) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Customers/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetCustomers>${getLoginXml('data')}<data:Body>${bodyFiltersXml(filters)}</data:Body></data:GetCustomers>
  </soapenv:Body>
</soapenv:Envelope>`;
  const raw = await postSoap('GetCustomers', xml);
  return { customers: parseCustomers(raw), raw };
}

function parseTransactions(xml) {
  return getAllBlocks(xml, 'Transaction').map((block) => {
    const items = getAllBlocks(block, 'Item').map((item) => ({
      lineNr: getNodeText(item, 'LineNr'),
      sku: getNodeText(item, 'Sku'),
      pieces: Number(getNodeText(item, 'Pieces') || 0),
      charged: Number(getNodeText(item, 'Charged') || 0),
      listPrice: Number(getNodeText(item, 'ListPrice') || 0),
      costPrice: Number(getNodeText(item, 'CostPrice') || 0)
    }));
    return {
      branchId: getNodeText(block, 'BranchId'),
      posNr: getNodeText(block, 'PosNr'),
      personnelId: getNodeText(block, 'PersonnelId'),
      dateTime: getNodeText(block, 'DateTime'),
      receiptNr: getNodeText(block, 'ReceiptNr') || getNodeText(block, 'ReceiptNo'),
      orderNr: getNodeText(block, 'OrderNr') || getNodeText(block, 'OrderNo'),
      customerId: getNodeText(block, 'CustomerId'),
      total: items.reduce((sum, item) => sum + Number(item.charged || 0), 0),
      items
    };
  });
}

export async function getTransactions({ customerId, from, until } = {}) {
  if (!customerId) return { transactions: [], raw: '' };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Customers/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetTransactions>${getLoginXml('data')}<data:Body><data:CustomerId>${xmlEscape(customerId)}</data:CustomerId><data:PeriodWithTime>${from ? `<data:From>${xmlEscape(from)}</data:From>` : ''}${until ? `<data:Until>${xmlEscape(until)}</data:Until>` : ''}</data:PeriodWithTime></data:Body></data:GetTransactions>
  </soapenv:Body>
</soapenv:Envelope>`;
  const raw = await postSoap('GetTransactions', xml);
  return { transactions: parseTransactions(raw), raw };
}

function parseBills(xml) {
  return getAllBlocks(xml, 'Bill').map((block) => ({
    billNr: getNodeText(block, 'BillNr'),
    customerId: getNodeText(block, 'CustomerId'),
    amount: Number(getNodeText(block, 'Amount') || 0),
    amountPaid: Number(getNodeText(block, 'AmountPaid') || 0),
    paid: getNodeText(block, 'Paid'),
    branchId: getNodeText(block, 'BranchId'),
    dateTime: getNodeText(block, 'DateTime'),
    receiptNr: getNodeText(block, 'ReceiptNr')
  }));
}

export async function getBills({ customerId, includePaid = true } = {}) {
  if (!customerId) return { bills: [], raw: '' };
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Customers/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetBills>${getLoginXml('data')}<data:Body><data:CustomerId>${xmlEscape(customerId)}</data:CustomerId><data:IncludePaid>${includePaid ? 'true' : 'false'}</data:IncludePaid></data:Body></data:GetBills>
  </soapenv:Body>
</soapenv:Envelope>`;
  const raw = await postSoap('GetBills', xml);
  return { bills: parseBills(raw), raw };
}

export async function createCustomer(customer = {}) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Customers/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:cus="https://messages.storeinfo.nl/v1/Customers">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Create>${getTransactionHeaderXml('tran')}<tran:Body><tran:Customers><tran:Customer><cus:Name>${customer.title ? `<cus:Title>${xmlEscape(customer.title)}</cus:Title>` : ''}${customer.firstName ? `<cus:FirstName>${xmlEscape(customer.firstName)}</cus:FirstName>` : ''}${customer.lastName ? `<cus:LastName>${xmlEscape(customer.lastName)}</cus:LastName>` : ''}</cus:Name>${customer.gender ? `<cus:Gender>${xmlEscape(customer.gender)}</cus:Gender>` : ''}${customer.birthDate ? `<cus:BirthDate>${xmlEscape(customer.birthDate)}</cus:BirthDate>` : ''}${customer.registeredInBranchId ? `<cus:RegisteredInBranchId>${xmlEscape(customer.registeredInBranchId)}</cus:RegisteredInBranchId>` : ''}<cus:AllowMailings>${customer.allowMailings ? 'true' : 'false'}</cus:AllowMailings><cus:ReceivesLoyaltyPoints>${customer.receivesLoyaltyPoints !== false ? 'true' : 'false'}</cus:ReceivesLoyaltyPoints>${customer.email ? `<cus:EmailAddresses><cus:EmailAddress><cus:Type>0</cus:Type><cus:EmailAddress>${xmlEscape(customer.email)}</cus:EmailAddress></cus:EmailAddress></cus:EmailAddresses>` : ''}</tran:Customer></tran:Customers></tran:Body></tran:Create>
  </soapenv:Body>
</soapenv:Envelope>`;
  const raw = await postSoap('Create', xml);
  return { customers: parseCustomers(raw), status: getNodeText(raw, 'Status'), raw };
}
