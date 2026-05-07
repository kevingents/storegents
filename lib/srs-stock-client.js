import { getSrsBranchMap } from './srs-branches.js';

const DEFAULT_SRS_BASE_URL = 'https://ws.srs.nl';
const STOCK_PATH = '/messages/v1/soap/Stock.php';
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

  return { id, password, endpoint: `${baseUrl}${STOCK_PATH}` };
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

function numeric(value) {
  const n = Number(String(value || '').replace(',', '.'));
  return Number.isFinite(n) ? n : 0;
}

function branchNameById(branchId) {
  const map = getSrsBranchMap();
  const found = Object.entries(map).find(([, id]) => String(id) === String(branchId));
  return found ? found[0] : '';
}

function unique(values) {
  return Array.from(new Set((values || []).map((value) => String(value || '').trim()).filter(Boolean)));
}

function parseBarcodes(block) {
  return getAllBlocks(block, 'Barcode').map((barcodeBlock) => ({
    id: firstNodeText(barcodeBlock, ['Id', 'BarcodeId']),
    type: firstNodeText(barcodeBlock, ['Type'])
  })).filter((barcode) => barcode.id);
}

function parseStockProductBlock(productBlock) {
  const productNr = firstNodeText(productBlock, ['ProductNr', 'ProductNumber']);
  const variantBlocks = getAllBlocks(productBlock, 'Variant');
  const rows = [];

  for (const variantBlock of variantBlocks) {
    const sku = firstNodeText(variantBlock, ['Sku', 'SKU']);
    const barcodes = parseBarcodes(variantBlock);
    const stockBlocks = getAllBlocks(variantBlock, 'StockLevel');

    for (const stockBlock of stockBlocks) {
      const branchId = firstNodeText(stockBlock, ['BranchId']);
      rows.push({
        productNr,
        sku,
        barcode: barcodes[0]?.id || '',
        barcodes,
        branchId,
        branchName: branchNameById(branchId),
        type: firstNodeText(stockBlock, ['Type']) || 'available',
        pieces: numeric(firstNodeText(stockBlock, ['Pieces']))
      });
    }
  }

  return rows;
}

function parseGetStockResponse(xml) {
  const timestamp = getNodeText(xml, 'Timestamp');
  const bodyBlock = getNodeText(xml, 'Body') || xml;
  const productBlocks = getAllBlocks(bodyBlock, 'Product');
  const stockRows = productBlocks.flatMap(parseStockProductBlock);

  return {
    success: true,
    responseTimestamp: timestamp,
    count: stockRows.length,
    stockRows,
    raw: xml
  };
}

export async function getStock({ branchIds = [], barcodes = [], productNrs = [] } = {}) {
  const branches = unique(branchIds);
  const barcodeList = unique(barcodes);
  const productList = unique(productNrs);
  const { id, password } = getSrsConfig();

  if (!branches.length) throw new Error('Geen SRS BranchId ontvangen voor voorraadcheck.');
  if (!barcodeList.length && !productList.length) throw new Error('Geen barcodes of artikelnummers ontvangen voor voorraadcheck.');

  const branchesXml = branches.map((branchId) => `
          <data:Branches>
            <data:BranchId>${xmlEscape(branchId)}</data:BranchId>
          </data:Branches>`).join('');

  const productBarcodeXml = barcodeList.map((barcode) => `
          <data:Products>
            <data:Barcode>${xmlEscape(barcode)}</data:Barcode>
          </data:Products>`).join('');

  const productNrXml = productList.map((productNr) => `
          <data:Products>
            <data:ProductNr>${xmlEscape(productNr)}</data:ProductNr>
          </data:Products>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.srs.nl/v1/Stock/Data" xmlns:com="https://messages.srs.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetStock>
      <data:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </data:Login>
      <data:Body>${branchesXml}${productBarcodeXml}${productNrXml}
      </data:Body>
    </data:GetStock>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetStock', xml);
  return parseGetStockResponse(responseText);
}

export function summarizeStockByBarcode(stockRows = []) {
  const map = new Map();

  for (const row of stockRows || []) {
    const keys = unique([row.sku, row.barcode, ...(row.barcodes || []).map((barcode) => barcode.id)]);
    for (const key of keys) {
      if (!map.has(key)) {
        map.set(key, {
          key,
          totalAvailable: 0,
          branches: []
        });
      }
      const current = map.get(key);
      if (String(row.type || '').toLowerCase() === 'available') {
        current.totalAvailable += Number(row.pieces || 0);
      }
      current.branches.push(row);
    }
  }

  return Object.fromEntries(map.entries());
}
