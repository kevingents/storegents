const DEFAULT_BASE_URL = 'https://ws.srs.nl';
const STOCK_PATH = '/messages/v1/soap/Stock.php';
const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 20000);
const DEFAULT_LOST_FOUND_BRANCH_ID = '706';

function clean(value) {
  return String(value || '').trim();
}

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
  const baseUrl = (process.env.SRS_STOCK_BASE_URL || process.env.SRS_MESSAGE_BASE_URL || process.env.SRS_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!id || !password) throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken.');
  return { id, password, endpoint: `${baseUrl}${STOCK_PATH}` };
}

function loginXml() {
  const { id, password } = getConfig();
  return `<data:Login><com:Id>${xmlEscape(id)}</com:Id><com:Password>${xmlEscape(password)}</com:Password></data:Login>`;
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
  return { code: faultCode, message: faultString || 'SRS SOAP fault' };
}

async function postSoap(action, xml) {
  const { endpoint } = getConfig();
  const controller = new AbortController();
  const timeout = Number.isFinite(SOAP_TIMEOUT_MS) && SOAP_TIMEOUT_MS > 0 ? SOAP_TIMEOUT_MS : 20000;
  const timer = setTimeout(() => controller.abort(), timeout);

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
      const error = new Error(fault?.message || `SRS Stock fout: ${response.status}`);
      error.status = response.status;
      error.fault = fault;
      error.responseText = text;
      throw error;
    }
    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`SRS Stock timeout na ${timeout}ms (${action}).`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function stockLevelFromBlock(block) {
  return {
    branchId: clean(getNodeText(block, 'BranchId')),
    type: clean(getNodeText(block, 'Type') || 'available'),
    pieces: Number(getNodeText(block, 'Pieces') || 0)
  };
}

function parseStockResponse(raw, { barcode = '', sku = '', branchId = '' } = {}) {
  const stockLevels = getAllBlocks(raw, 'StockLevel').map(stockLevelFromBlock);
  const wantedBranch = clean(branchId);
  const availableLevels = stockLevels.filter((level) => clean(level.type).toLowerCase() === 'available');
  const branchLevels = wantedBranch ? availableLevels.filter((level) => clean(level.branchId) === wantedBranch) : availableLevels;
  const pieces = branchLevels.reduce((sum, level) => sum + Number(level.pieces || 0), 0);

  return { success: true, checkedAt: new Date().toISOString(), barcode: clean(barcode), sku: clean(sku || barcode), branchId: wantedBranch, pieces, stockLevels };
}

export async function getStock({ barcode = '', sku = '', branchId = '' } = {}) {
  const productValue = clean(barcode || sku);
  if (!productValue) throw new Error('SRS Stock barcode/sku ontbreekt.');

  const branchXml = clean(branchId) ? `<data:Branches><data:BranchId>${xmlEscape(clean(branchId))}</data:BranchId></data:Branches>` : '';
  const productXml = barcode ? `<data:Products><data:Barcode>${xmlEscape(productValue)}</data:Barcode></data:Products>` : `<data:Products><data:Sku>${xmlEscape(productValue)}</data:Sku></data:Products>`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.srs.nl/v1/Stock/Data" xmlns:com="https://messages.srs.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetStock>${loginXml()}<data:Body>${branchXml}${productXml}</data:Body></data:GetStock>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('GetStock', xml);
  return parseStockResponse(raw, { barcode: productValue, sku: productValue, branchId });
}

export async function getUnavailableStockSnapshot({ barcode = '', sku = '', branchId = '', lostFoundBranchId = DEFAULT_LOST_FOUND_BRANCH_ID } = {}) {
  const snapshot = {
    checkedAt: new Date().toISOString(),
    branchId: clean(branchId),
    barcode: clean(barcode || sku),
    sku: clean(sku || barcode),
    storeStock: null,
    lostFoundBranchId: clean(lostFoundBranchId),
    lostFoundStock: null,
    errors: []
  };

  if (!snapshot.barcode) {
    snapshot.errors.push({ source: 'stock_snapshot', message: 'Geen barcode/sku beschikbaar.' });
    return snapshot;
  }

  if (snapshot.branchId) {
    try {
      const store = await getStock({ barcode: snapshot.barcode, branchId: snapshot.branchId });
      snapshot.storeStock = Number(store.pieces || 0);
      snapshot.storeStockCheckedAt = store.checkedAt;
    } catch (error) {
      snapshot.errors.push({ source: 'store_stock', branchId: snapshot.branchId, message: error.message || String(error) });
    }
  }

  if (snapshot.lostFoundBranchId) {
    try {
      const lostFound = await getStock({ barcode: snapshot.barcode, branchId: snapshot.lostFoundBranchId });
      snapshot.lostFoundStock = Number(lostFound.pieces || 0);
      snapshot.lostFoundStockCheckedAt = lostFound.checkedAt;
    } catch (error) {
      snapshot.errors.push({ source: 'lost_found_stock', branchId: snapshot.lostFoundBranchId, message: error.message || String(error) });
    }
  }

  return snapshot;
}
