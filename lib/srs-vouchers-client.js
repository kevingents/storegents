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


export async function getVoucherLock({ barcode, timeoutSecs = 600, sessionId = '' }) {
  const session = await getSession(sessionId);

  if (!barcode) {
    throw new Error('Vouchercode ontbreekt voor voucher lock.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:getVoucherLock soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <barcode xsi:type="xsd:string">${xmlEscape(barcode)}</barcode>
      <timeout_secs xsi:type="xsd:int">${Number(timeoutSecs || 600)}</timeout_secs>
    </si:getVoucherLock>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('getVoucherLock', xml);
  const voucherLockId = getReturnText(responseText);

  if (!voucherLockId) {
    throw new Error('SRS gaf geen voucherLockID terug.');
  }

  return {
    barcode,
    voucherLockId,
    timeoutSecs: Number(timeoutSecs || 600)
  };
}

export async function cancelVoucherLock({ barcode, voucherLockId, sessionId = '' }) {
  const session = await getSession(sessionId);

  if (!barcode || !voucherLockId) {
    throw new Error('Vouchercode en voucherLockID zijn verplicht om een lock te annuleren.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:cancelVoucherLock soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <barcode xsi:type="xsd:string">${xmlEscape(barcode)}</barcode>
      <voucherLockID xsi:type="xsd:string">${xmlEscape(voucherLockId)}</voucherLockID>
    </si:cancelVoucherLock>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('cancelVoucherLock', xml);
  return {
    barcode,
    voucherLockId,
    result: getReturnText(responseText)
  };
}

export async function boekVoucherExtern({ barcode, voucherLockId, branchId, sessionId = '' }) {
  const session = await getSession(sessionId);

  if (!barcode || !voucherLockId || !branchId) {
    throw new Error('Vouchercode, voucherLockID en filiaalId zijn verplicht voor boekVoucherExtern.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:boekVoucherExtern soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <barcode xsi:type="xsd:string">${xmlEscape(barcode)}</barcode>
      <voucherLockID xsi:type="xsd:string">${xmlEscape(voucherLockId)}</voucherLockID>
      <filiaalId xsi:type="xsd:int">${Number(branchId)}</filiaalId>
    </si:boekVoucherExtern>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('boekVoucherExtern', xml);
  const result = getReturnText(responseText);

  return {
    barcode,
    voucherLockId,
    branchId,
    result,
    success: String(result).toLowerCase() === 'true'
  };
}

export async function redeemVoucherForWebshop({ barcode, branchId, timeoutSecs = 600 }) {
  const sessionId = await loginSrsVoucherService();
  const lock = await getVoucherLock({ barcode, timeoutSecs, sessionId });

  try {
    const redeemed = await boekVoucherExtern({
      barcode,
      voucherLockId: lock.voucherLockId,
      branchId,
      sessionId
    });

    if (!redeemed.success) {
      throw new Error('SRS boekVoucherExtern gaf geen true terug.');
    }

    return {
      barcode,
      branchId,
      voucherLockId: lock.voucherLockId,
      redeemed: true,
      result: redeemed.result
    };
  } catch (error) {
    try {
      await cancelVoucherLock({ barcode, voucherLockId: lock.voucherLockId, sessionId });
    } catch (cancelError) {
      console.error('SRS voucher lock annuleren mislukt:', cancelError);
    }

    throw error;
  }
}


export async function getClosedVouchers({ dateFrom, dateTo, sessionId = '' }) {
  const session = await getSession(sessionId);

  if (!dateFrom || !dateTo) {
    throw new Error('dateFrom en dateTo zijn verplicht voor getClosedVouchers.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:getClosedVouchers soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <datum_vanaf xsi:type="xsd:string">${xmlEscape(dateFrom)}</datum_vanaf>
      <datum_tm xsi:type="xsd:string">${xmlEscape(dateTo)}</datum_tm>
    </si:getClosedVouchers>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('getClosedVouchers', xml);
  const raw = getReturnText(responseText) || '';
  const parts = raw.split(';').map((part) => part.trim()).filter(Boolean);
  const closed = [];

  for (let i = 0; i < parts.length; i += 3) {
    const barcode = parts[i] || '';
    const receiptNumber = parts[i + 1] || '';
    const branchId = parts[i + 2] || '';

    if (barcode) {
      closed.push({
        barcode,
        receiptNumber,
        branchId
      });
    }
  }

  return {
    raw,
    closed
  };
}


export async function makeVouchersInBulk({
  voucherType,
  customerIds,
  validFrom,
  validTo,
  sessionId = ''
}) {
  const session = await getSession(sessionId);

  if (!voucherType) {
    throw new Error('SRS voucher_type ontbreekt.');
  }

  if (!Array.isArray(customerIds) || !customerIds.length) {
    throw new Error('Geen SRS customer_ids ontvangen.');
  }

  if (!validFrom || !validTo) {
    throw new Error('Geldigheidsperiode ontbreekt.');
  }

  const customerItemsXml = customerIds.map((customerId) => `
        <item>
          <customer_id>${xmlEscape(customerId)}</customer_id>
        </item>
  `).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_voucherservice.php" xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/">
  <soapenv:Header/>
  <soapenv:Body>
    <si:makeVouchersInBulk soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <voucher_type xsi:type="xsd:int">${xmlEscape(voucherType)}</voucher_type>
      <customer_ids xsi:type="si:ArrayOfVoucherCustomer" soapenc:arrayType="si:VoucherCustomer[]">
        ${customerItemsXml}
      </customer_ids>
      <valid_from xsi:type="xsd:string">${xmlEscape(validFrom)}</valid_from>
      <valid_to xsi:type="xsd:string">${xmlEscape(validTo)}</valid_to>
    </si:makeVouchersInBulk>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('makeVouchersInBulk', xml);
  const items = getAllBlocks(responseText, 'item');

  return items.map((item) => ({
    customerId: getNodeText(item, 'customer_id'),
    barcode: getNodeText(item, 'barcode')
  })).filter((item) => item.customerId || item.barcode);
}

