const DEFAULT_SRS_API_BASE_URL = 'https://ws.srs.nl';
const VOUCHER_SERVICE_PATH = '/webservices/si_voucherservice.php';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getConfig() {
  const user = process.env.SRS_API_USER || process.env.SRS_VOUCHER_API_USER || '';
  const password = process.env.SRS_API_PASSWORD || process.env.SRS_VOUCHER_API_PASSWORD || '';
  const baseUrl = (process.env.SRS_API_BASE_URL || process.env.SRS_BASE_URL || DEFAULT_SRS_API_BASE_URL).replace(/\/$/, '');

  if (!user || !password) {
    throw new Error('SRS_API_USER en/of SRS_API_PASSWORD ontbreken.');
  }

  return {
    user,
    password,
    endpoint: `${baseUrl}${VOUCHER_SERVICE_PATH}`
  };
}

function getNodeText(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const match = String(xml || '').match(regex);
  return match ? match[1].trim() : '';
}

function getReturnText(xml) {
  return getNodeText(xml, 'return');
}

function getAllBlocks(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'gi');
  return Array.from(String(xml || '').matchAll(regex)).map((match) => match[1]);
}

function parseSoapFault(xml) {
  const faultString = getNodeText(xml, 'faultstring') || getNodeText(xml, 'Reason') || getNodeText(xml, 'Text');
  const faultCode = getNodeText(xml, 'faultcode') || getNodeText(xml, 'Code');
  return faultString || faultCode ? { code: faultCode, message: faultString || 'SRS SOAP fault' } : null;
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
    const error = new Error(fault?.message || `SRS voucher fout: ${response.status}`);
    error.status = response.status;
    error.fault = fault;
    error.responseText = text;
    throw error;
  }

  return text;
}

export function centsToAmount(value) {
  const cents = Number(value || 0);
  return Number.isFinite(cents) ? (cents / 100).toFixed(2) : '0.00';
}

export async function loginSrsVoucherService() {
  const { user, password } = getConfig();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:Login soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <user_id xsi:type="xsd:string">${xmlEscape(user)}</user_id>
      <password xsi:type="xsd:string">${xmlEscape(password)}</password>
    </si:Login>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('Login', xml);
  const sessionId = getReturnText(responseText);

  if (!sessionId) {
    throw new Error('SRS gaf geen session_id terug.');
  }

  return sessionId;
}

async function getSession(sessionId) {
  return sessionId || loginSrsVoucherService();
}

export async function getVoucherGroups({ sessionId = '' } = {}) {
  const session = await getSession(sessionId);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:getVoucherGroups soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
    </si:getVoucherGroups>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('getVoucherGroups', xml);
  return getAllBlocks(responseText, 'item').map((item) => ({
    voucherGroupId: getNodeText(item, 'voucherGroupId'),
    voucherGroupName: getNodeText(item, 'voucherGroupName'),
    voucherValue: getNodeText(item, 'voucherValue')
  })).filter((item) => item.voucherGroupId);
}

export async function makeVoucher({ voucherType, customerId, validFrom, validTo, sessionId = '' }) {
  const session = await getSession(sessionId);

  if (!voucherType || !customerId || !validFrom || !validTo) {
    throw new Error('voucherType, customerId, validFrom en validTo zijn verplicht.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:makeVoucher soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <voucher_type xsi:type="xsd:int">${xmlEscape(voucherType)}</voucher_type>
      <customer_id xsi:type="xsd:string">${xmlEscape(customerId)}</customer_id>
      <valid_from xsi:type="xsd:string">${xmlEscape(validFrom)}</valid_from>
      <valid_to xsi:type="xsd:string">${xmlEscape(validTo)}</valid_to>
    </si:makeVoucher>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('makeVoucher', xml);
  const barcode = getReturnText(responseText);

  if (!barcode) {
    throw new Error('SRS gaf geen vouchercode terug.');
  }

  return { barcode, customerId, voucherType, validFrom, validTo };
}

export async function checkVoucher({ barcode, sessionId = '' }) {
  const session = await getSession(sessionId);

  if (!barcode) {
    throw new Error('Vouchercode ontbreekt.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:checkVoucher soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <barcode xsi:type="xsd:string">${xmlEscape(barcode)}</barcode>
      <noNulls xsi:type="xsd:boolean">false</noNulls>
    </si:checkVoucher>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('checkVoucher', xml);
  const returnBlock = getNodeText(responseText, 'return');
  const valueCents = Number(getNodeText(returnBlock, 'value') || 0);

  return {
    barcode,
    info: getNodeText(returnBlock, 'info'),
    valueCents,
    amount: centsToAmount(valueCents),
    status: getNodeText(returnBlock, 'status'),
    unique: getNodeText(returnBlock, 'unique'),
    currency: getNodeText(returnBlock, 'currency') || 'EUR',
    customerId: getNodeText(returnBlock, 'klant'),
    description: getNodeText(returnBlock, 'omschrijving'),
    maximumAantalProducten: getNodeText(returnBlock, 'maximumAantalProducten'),
    minimumPurchaseAmount: getNodeText(returnBlock, 'minimumPurchaseAmount')
  };
}

export async function getCustomerVouchers({ customerId, sessionId = '' }) {
  const session = await getSession(sessionId);

  if (!customerId) {
    throw new Error('SRS klant_id ontbreekt.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:getKlantVoucher soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <klant_id xsi:type="xsd:int">${xmlEscape(customerId)}</klant_id>
    </si:getKlantVoucher>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('getKlantVoucher', xml);
  return getAllBlocks(responseText, 'item').map((item) => ({
    text: getNodeText(item, 'text'),
    barcode: getNodeText(item, 'barcode'),
    valueCents: Number(getNodeText(item, 'waarde') || 0),
    amount: centsToAmount(getNodeText(item, 'waarde')),
    validTo: getNodeText(item, 'geldig_tm'),
    validFrom: getNodeText(item, 'geldig_vanaf'),
    customerId: getNodeText(item, 'klant'),
    cardNumber: getNodeText(item, 'kaartnummer'),
    maximumAantalProducten: getNodeText(item, 'maximumAantalProducten')
  })).filter((item) => item.barcode);
}
