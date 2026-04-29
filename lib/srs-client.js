import crypto from 'crypto';

const DEFAULT_SRS_BASE_URL = 'https://ws.srs.nl';
const WEBORDERS_PATH = '/messages/v1/soap/Weborders.php';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getSrsConfig() {
  const id = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  const baseUrl = (process.env.SRS_BASE_URL || DEFAULT_SRS_BASE_URL).replace(/\/$/, '');

  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken in Vercel Environment Variables.');
  }

  return {
    id,
    password,
    endpoint: `${baseUrl}${WEBORDERS_PATH}`
  };
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

  if (!faultString && !faultCode) {
    return null;
  }

  return {
    code: faultCode,
    message: faultString || 'SRS SOAP fault'
  };
}

async function postSoap(action, xml) {
  const { endpoint } = getSrsConfig();

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
    const error = new Error(fault?.message || `SRS fout: ${response.status}`);
    error.status = response.status;
    error.fault = fault;
    error.responseText = text;
    throw error;
  }

  return text;
}

function buildMessageLoginXml(prefix = 'data') {
  const { id, password } = getSrsConfig();

  return `
    <${prefix}:Login>
      <com:Id>${xmlEscape(id)}</com:Id>
      <com:Password>${xmlEscape(password)}</com:Password>
    </${prefix}:Login>
  `;
}

export function normalizeOrderNr(value) {
  return String(value || '').trim();
}

export async function getSrsFulfillments(orderNr) {
  const cleanOrderNr = normalizeOrderNr(orderNr);

  if (!cleanOrderNr) {
    throw new Error('SRS OrderNr ontbreekt.');
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Weborders/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetFulfillments>
      ${buildMessageLoginXml('data')}
      <data:Body>
        <data:OrderNr>${xmlEscape(cleanOrderNr)}</data:OrderNr>
      </data:Body>
    </data:GetFulfillments>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetFulfillments', xml);
  const blocks = getAllBlocks(responseText, 'Fulfillment');

  const fulfillments = blocks.map((block) => ({
    fulfillmentId: getNodeText(block, 'FulfillmentId'),
    createdAt: getNodeText(block, 'CreatedAt'),
    updatedAt: getNodeText(block, 'UpdatedAt'),
    orderNr: getNodeText(block, 'OrderNr'),
    status: getNodeText(block, 'Status'),
    orderLineNr: getNodeText(block, 'OrderLineNr'),
    sku: getNodeText(block, 'Sku'),
    branchId: getNodeText(block, 'BranchId'),
    multipleFulfillmentsOpen: getNodeText(block, 'MultipleFulfillmentsOpen')
  })).filter((item) => item.fulfillmentId || item.sku);

  return {
    orderNr: cleanOrderNr,
    fulfillments,
    raw: responseText
  };
}

function buildSrsReturnItem(item, fulfillment) {
  const fulfillmentId = item.fulfillmentId || fulfillment?.fulfillmentId || '';
  const orderLineNr = item.orderLineNr || item.orderLineNumber || '';
  const sku = item.sku || item.barcode || fulfillment?.sku || '';
  const barcode = item.barcode || item.sku || fulfillment?.sku || '';
  const pieces = Number(item.quantity || item.pieces || 1);
  const price = Number(item.price || item.unitPrice || 0);

  let identifierXml = '';

  if (fulfillmentId) {
    identifierXml += `<web:FulfillmentId>${xmlEscape(fulfillmentId)}</web:FulfillmentId>`;
  } else if (orderLineNr) {
    identifierXml += `<web:OrderLineNr>${xmlEscape(orderLineNr)}</web:OrderLineNr>`;
  }

  if (barcode) {
    identifierXml += `<web:Barcode>${xmlEscape(barcode)}</web:Barcode>`;
  } else if (sku) {
    identifierXml += `<web:Sku>${xmlEscape(sku)}</web:Sku>`;
  }

  return `
    <web:Item>
      ${identifierXml}
      <web:Pieces>${Number.isFinite(pieces) && pieces > 0 ? pieces : 1}</web:Pieces>
      <web:Price>${Number.isFinite(price) ? price.toFixed(2) : '0.00'}</web:Price>
    </web:Item>
  `;
}

function normalizeSku(value) {
  return String(value || '').trim().toLowerCase();
}

function matchFulfillmentForItem(item, fulfillments) {
  const fulfillmentId = String(item.fulfillmentId || '').trim();
  if (fulfillmentId) {
    const byFulfillmentId = fulfillments.find((fulfillment) => {
      return String(fulfillment.fulfillmentId || '').trim() === fulfillmentId;
    });
    if (byFulfillmentId) return byFulfillmentId;
  }

  const orderLineNr = String(item.orderLineNr || item.orderLineNumber || '').trim();
  if (orderLineNr) {
    const byOrderLineNr = fulfillments.find((fulfillment) => {
      return String(fulfillment.orderLineNr || '').trim() === orderLineNr;
    });
    if (byOrderLineNr) return byOrderLineNr;
  }

  const sku = normalizeSku(item.sku || item.barcode);

  if (!sku) {
    return null;
  }

  return fulfillments.find((fulfillment) => {
    return normalizeSku(fulfillment.sku) === sku;
  }) || null;
}

export async function createSrsReturn({
  orderNr,
  branchId,
  items,
  dateTime
}) {
  const cleanOrderNr = normalizeOrderNr(orderNr);

  if (!cleanOrderNr) {
    throw new Error('SRS OrderNr ontbreekt.');
  }

  if (!branchId) {
    throw new Error('SRS BranchId ontbreekt.');
  }

  if (!items || !items.length) {
    throw new Error('Geen retourregels ontvangen voor SRS.');
  }

  const fulfillmentsResult = await getSrsFulfillments(cleanOrderNr);
  const fulfillments = fulfillmentsResult.fulfillments || [];

  const unresolvedItems = [];

  const itemXml = items.map((item, index) => {
    const matchedFulfillment = matchFulfillmentForItem(item, fulfillments);
    if (!matchedFulfillment && !item.fulfillmentId && !item.orderLineNr && !item.orderLineNumber) {
      unresolvedItems.push({
        index,
        sku: item.sku || item.barcode || '',
        quantity: item.quantity || item.pieces || 1
      });
    }
    return buildSrsReturnItem(item, matchedFulfillment);
  }).join('');

  if (unresolvedItems.length) {
    const missingSkus = unresolvedItems.map((item) => item.sku).filter(Boolean).join(', ');
    throw new Error(`Retourregels konden niet aan fulfillment worden gekoppeld (${missingSkus || 'onbekende sku'}). Geef fulfillmentId of orderLineNr mee.`);
  }

  const transactionId = crypto.randomUUID();
  const timestamp = new Date().toISOString().slice(0, 19);
  const returnDateTime = dateTime || timestamp;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Weborders/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:web="https://messages.storeinfo.nl/v1/Weborders">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Return>
      <tran:Header>
        <com:Login>
          <com:Id>${xmlEscape(getSrsConfig().id)}</com:Id>
          <com:Password>${xmlEscape(getSrsConfig().password)}</com:Password>
        </com:Login>
        <com:TransactionId>${xmlEscape(transactionId)}</com:TransactionId>
        <com:Timestamp>${xmlEscape(timestamp)}</com:Timestamp>
      </tran:Header>
      <tran:Body>
        <tran:OrderNr>${xmlEscape(cleanOrderNr)}</tran:OrderNr>
        <tran:BranchId>${xmlEscape(branchId)}</tran:BranchId>
        <tran:DateTime>${xmlEscape(returnDateTime)}</tran:DateTime>
        <tran:Items>
          ${itemXml}
        </tran:Items>
      </tran:Body>
    </tran:Return>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('Return', xml);
  const status = getNodeText(responseText, 'Status') || 'unknown';
  const responseTransactionId = getNodeText(responseText, 'TransactionId') || transactionId;

  return {
    success: String(status).toLowerCase() === 'completed',
    status,
    transactionId: responseTransactionId,
    orderNr: cleanOrderNr,
    branchId,
    items,
    fulfillments,
    raw: responseText
  };
}
