import crypto from 'crypto';
import { getSrsBranchMap } from './srs-branches.js';

const DEFAULT_SRS_BASE_URL = 'https://ws.srs.nl';
const PURCHASE_ORDERS_PATH = '/messages/v1/soap/PurchaseOrders.php';
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
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken in Vercel Environment Variables.');
  }

  return { id, password, endpoint: `${baseUrl}${PURCHASE_ORDERS_PATH}` };
}

function getNodeText(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const match = String(xml || '').match(regex);
  return match ? decodeXml(match[1]) : '';
}

function firstNodeText(xml, names) {
  for (const name of names) {
    const value = getNodeText(xml, name);
    if (value) return value;
  }
  return '';
}

function getAllBlocks(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'gi');
  return Array.from(String(xml || '').matchAll(regex)).map((match) => match[1]);
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
      const error = new Error(fault?.message || `SRS fout: ${response.status}`);
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

function toDateTimeStart(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T00:00:00`;
  return raw;
}

function toDateTimeEnd(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return `${raw}T23:59:59`;
  return raw;
}

function defaultRange(days = 30) {
  const until = new Date();
  const from = new Date();
  from.setDate(until.getDate() - Math.min(Math.max(Number(days || 30), 1), 365));
  return {
    from: from.toISOString().slice(0, 10),
    until: until.toISOString().slice(0, 10)
  };
}

function branchNameById(branchId) {
  const map = getSrsBranchMap();
  const found = Object.entries(map).find(([, id]) => String(id) === String(branchId));
  return found ? found[0] : '';
}

function numeric(value) {
  const n = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function parseBarcodes(block) {
  return getAllBlocks(block, 'Barcode').map((barcodeBlock) => ({
    id: firstNodeText(barcodeBlock, ['Id', 'BarcodeId']),
    type: firstNodeText(barcodeBlock, ['Type'])
  })).filter((barcode) => barcode.id);
}

function parseProducts(productsBlock) {
  const productBlocks = getAllBlocks(productsBlock, 'Product');
  const products = [];

  for (const productBlock of productBlocks) {
    const productNr = firstNodeText(productBlock, ['ProductNr', 'ProductNumber']);
    const variantBlocks = getAllBlocks(productBlock, 'Variant');

    for (const variantBlock of variantBlocks) {
      const barcodes = parseBarcodes(variantBlock);
      products.push({
        productNr,
        sku: firstNodeText(variantBlock, ['Sku', 'SKU']),
        barcode: barcodes[0]?.id || firstNodeText(variantBlock, ['Barcode']),
        barcodes,
        purchasePrice: numeric(firstNodeText(variantBlock, ['PurchasePrice'])),
        piecesOrdered: numeric(firstNodeText(variantBlock, ['PiecesOrdered'])),
        piecesReceived: numeric(firstNodeText(variantBlock, ['PiecesReceived'])),
        piecesOpen: Math.max(0, numeric(firstNodeText(variantBlock, ['PiecesOrdered'])) - numeric(firstNodeText(variantBlock, ['PiecesReceived'])))
      });
    }
  }

  return products;
}

function parsePurchaseOrderBlock(block) {
  const supplierBlock = getNodeText(block, 'Supplier');
  const statusBlock = getNodeText(block, 'Status');
  const productsBlock = getNodeText(block, 'Products');
  const branchId = firstNodeText(block, ['BranchId']);
  const products = parseProducts(productsBlock);
  const piecesOrdered = products.reduce((sum, product) => sum + Number(product.piecesOrdered || 0), 0);
  const piecesReceived = products.reduce((sum, product) => sum + Number(product.piecesReceived || 0), 0);

  return {
    orderNr: firstNodeText(block, ['OrderNr']),
    orderReference: firstNodeText(block, ['OrderReference']),
    supplier: {
      id: firstNodeText(supplierBlock, ['Id']),
      name: firstNodeText(supplierBlock, ['Name'])
    },
    status: {
      id: firstNodeText(statusBlock, ['Id']),
      name: firstNodeText(statusBlock, ['Name'])
    },
    orderDate: firstNodeText(block, ['OrderDate']),
    branchId,
    branchName: branchNameById(branchId),
    piecesOrdered,
    piecesReceived,
    piecesOpen: Math.max(0, piecesOrdered - piecesReceived),
    isOpen: piecesOrdered > piecesReceived && !['2', '3'].includes(String(firstNodeText(statusBlock, ['Id']))),
    products
  };
}

export async function getPurchaseOrders({ from, until, days = 30, branchId = '', status = 'all' } = {}) {
  const range = defaultRange(days);
  const dateFrom = toDateTimeStart(from || range.from);
  const dateUntil = toDateTimeEnd(until || range.until);
  const { id, password } = getSrsConfig();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/PurchaseOrders/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetPurchaseOrders>
      <data:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </data:Login>
      <data:Body>
        <data:Created>
          <com:From>${xmlEscape(dateFrom)}</com:From>
          <com:Until>${xmlEscape(dateUntil)}</com:Until>
        </data:Created>
      </data:Body>
    </data:GetPurchaseOrders>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetPurchaseOrders', xml);
  const responseTimestamp = getNodeText(responseText, 'Timestamp');
  const bodyBlock = getNodeText(responseText, 'Body') || responseText;
  const orderBlocks = getAllBlocks(bodyBlock, 'PurchaseOrder').filter((block) => getNodeText(block, 'OrderNr'));
  let orders = orderBlocks.map(parsePurchaseOrderBlock);

  if (branchId) orders = orders.filter((order) => String(order.branchId) === String(branchId));
  if (status === 'open') orders = orders.filter((order) => order.isOpen);
  if (status === 'closed') orders = orders.filter((order) => !order.isOpen);

  return {
    success: true,
    from: dateFrom,
    until: dateUntil,
    responseTimestamp,
    count: orders.length,
    openCount: orders.filter((order) => order.isOpen).length,
    closedCount: orders.filter((order) => !order.isOpen).length,
    piecesOrdered: orders.reduce((sum, order) => sum + Number(order.piecesOrdered || 0), 0),
    piecesReceived: orders.reduce((sum, order) => sum + Number(order.piecesReceived || 0), 0),
    piecesOpen: orders.reduce((sum, order) => sum + Number(order.piecesOpen || 0), 0),
    orders,
    raw: responseText
  };
}

export function purchaseOrderSafetyIdeas() {
  return [
    'Blokkeer balansen of toon waarschuwingen voor SKU\'s die recent via PurchaseOrder Receive zijn binnengekomen maar nog niet geteld zijn.',
    'Maak een magazijn-checklijst van PurchaseOrders met PiecesReceived > 0 en orderdatum binnen de laatste 14 dagen.',
    'Vergelijk ontvangen aantallen met balanstelling per SKU en markeer afwijkingen direct.',
    'Gebruik ReceiveCorrection alleen als correctieflow met reden, medewerker en auditlog.'
  ];
}
