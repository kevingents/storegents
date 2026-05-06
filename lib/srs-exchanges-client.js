import crypto from 'crypto';
import { getSrsBranchMap } from './srs-branches.js';

const DEFAULT_SRS_BASE_URL = 'https://ws.srs.nl';
const UITWISSELING_PATH = '/messages/v1/soap/Uitwisseling.php';
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

  return { id, password, endpoint: `${baseUrl}${UITWISSELING_PATH}` };
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

function toDateOnly(value) {
  if (!value) return '';
  const date = parseSrsDateTime(value);
  if (!date) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function defaultDateRange(days = 60) {
  const until = new Date();
  const from = new Date();
  from.setDate(until.getDate() - Math.min(Math.max(Number(days || 60), 1), 365));
  return { from: from.toISOString().slice(0, 10), until: until.toISOString().slice(0, 10) };
}

function branchNameById(branchId) {
  const map = getSrsBranchMap();
  const found = Object.entries(map).find(([, id]) => String(id) === String(branchId));
  return found ? found[0] : '';
}

export function parseSrsDateTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const nlMatch = raw.match(/^(\d{1,2})-(\d{1,2})-(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (nlMatch) {
    const [, d, m, y, hh = '0', mm = '0', ss = '0'] = nlMatch;
    const date = new Date(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss));
    return Number.isNaN(date.getTime()) ? null : date;
  }

  const isoDate = new Date(raw);
  return Number.isNaN(isoDate.getTime()) ? null : isoDate;
}

function normalizeSrsDateTime(value) {
  const date = parseSrsDateTime(value);
  return date ? date.toISOString() : '';
}

function parseExchangeBlock(block, responseTimestamp = '') {
  const itemsBlock = getNodeText(block, 'Items') || block;
  const itemBlocks = getAllBlocks(itemsBlock, 'Item');

  const items = itemBlocks.map((itemBlock) => ({
    leverancier: firstNodeText(itemBlock, ['Leverancier', 'Supplier']),
    hoofdgroep: firstNodeText(itemBlock, ['Hoofdgroep', 'MainGroup']),
    artikelNr: firstNodeText(itemBlock, ['ArtikelNr', 'Artikelnummer', 'ArticleNumber']),
    artikelId: firstNodeText(itemBlock, ['ArtikelId', 'ArtikelID', 'ArticleId', 'Sku']),
    kleurId: firstNodeText(itemBlock, ['KleurId', 'KleurID', 'ColorId']),
    kleur: firstNodeText(itemBlock, ['Kleur', 'Color']),
    maatId: firstNodeText(itemBlock, ['MaatId', 'MaatID', 'SizeId']),
    maat: firstNodeText(itemBlock, ['Maat', 'Size']),
    sku: firstNodeText(itemBlock, ['Sku', 'SKU', 'Barcode', 'BarcodeId']),
    barcode: firstNodeText(itemBlock, ['Barcode', 'BarcodeId', 'Sku', 'SKU']),
    aantal: Number(firstNodeText(itemBlock, ['Aantal', 'Quantity', 'Pieces']) || 0),
    bonNr: firstNodeText(itemBlock, ['BonNr', 'Bon', 'ReceiptNr'])
  }));

  const vanFiliaal = firstNodeText(block, ['VanFiliaal', 'FromBranchId']);
  const naarFiliaal = firstNodeText(block, ['NaarFiliaal', 'ToBranchId']);
  const createdRaw = firstNodeText(block, ['CreatedAt', 'DateTime', 'Datum', 'AangemaaktOp', 'Created']);
  const createdAt = normalizeSrsDateTime(createdRaw);
  const verkoper = firstNodeText(block, ['Verkoper', 'Seller', 'AangemaaktDoor', 'CreatedBy', 'EmployeeName']);

  return {
    uitwisselingId: firstNodeText(block, ['UitwisselingId', 'ExchangeId']),
    vanFiliaal,
    naarFiliaal,
    vanWinkel: branchNameById(vanFiliaal),
    naarWinkel: branchNameById(naarFiliaal),
    verkoper,
    sellerName: verkoper,
    createdBy: verkoper,
    createdAt,
    createdAtRaw: createdRaw,
    dateTime: createdAt,
    aangemaaktOp: createdAt,
    responseTimestamp,
    itemCount: items.reduce((sum, item) => sum + Number(item.aantal || 0), 0),
    lineCount: items.length,
    items
  };
}

export async function getAllOpenstaandeUitwisselingen({ from, until, days } = {}) {
  const range = defaultDateRange(days || 60);
  const dateFrom = toDateOnly(from) || range.from;
  const dateUntil = toDateOnly(until) || range.until;
  const { id, password } = getSrsConfig();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Uitwisseling/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetAllOpenstaandeUitwisselingen>
      <data:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </data:Login>
      <data:Body>
        <data:Valid>
          <data:From>${xmlEscape(dateFrom)}</data:From>
          <data:Until>${xmlEscape(dateUntil)}</data:Until>
        </data:Valid>
      </data:Body>
    </data:GetAllOpenstaandeUitwisselingen>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('GetAllOpenstaandeUitwisselingen', xml);
  const responseTimestamp = getNodeText(responseText, 'Timestamp');
  const bodyBlock = getNodeText(responseText, 'Body') || responseText;
  const exchangeBlocks = getAllBlocks(bodyBlock, 'Uitwisseling').filter((block) => getNodeText(block, 'UitwisselingId'));
  const exchanges = exchangeBlocks.map((block) => parseExchangeBlock(block, responseTimestamp));

  return {
    from: dateFrom,
    until: dateUntil,
    responseTimestamp,
    count: exchanges.length,
    itemCount: exchanges.reduce((sum, exchange) => sum + Number(exchange.itemCount || 0), 0),
    exchanges,
    raw: responseText
  };
}

export async function processOpenstaandeUitwisselingen({ exchanges }) {
  if (!Array.isArray(exchanges) || !exchanges.length) throw new Error('Geen uitwisselingen ontvangen om te verwerken.');

  const { id, password } = getSrsConfig();
  const transactionId = crypto.randomUUID();
  const timestamp = new Date().toISOString().slice(0, 19);
  const exchangeXml = exchanges.map((exchange) => {
    const itemXml = (exchange.items || []).map((item) => `
            <uit:Item>
              <uit:Sku>${xmlEscape(item.sku)}</uit:Sku>
              <uit:Aantal>${Number(item.aantal || 0)}</uit:Aantal>
            </uit:Item>`).join('');

    return `
          <tran:Uitwisseling>
            <uit:UitwisselingId>${xmlEscape(exchange.uitwisselingId)}</uit:UitwisselingId>
            <uit:VanFiliaal>${xmlEscape(exchange.vanFiliaal)}</uit:VanFiliaal>
            <uit:NaarFiliaal>${xmlEscape(exchange.naarFiliaal)}</uit:NaarFiliaal>
            <uit:Items>${itemXml}
            </uit:Items>
          </tran:Uitwisseling>`;
  }).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Uitwisseling/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:uit="https://messages.storeinfo.nl/v1/Uitwisseling">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:ProcessOpenstaandeUitwisselingen>
      <tran:Header>
        <com:Login>
          <com:Id>${xmlEscape(id)}</com:Id>
          <com:Password>${xmlEscape(password)}</com:Password>
        </com:Login>
        <com:TransactionId>${xmlEscape(transactionId)}</com:TransactionId>
        <com:Timestamp>${xmlEscape(timestamp)}</com:Timestamp>
      </tran:Header>
      <tran:Body>
        <tran:Uitwisselingen>${exchangeXml}
        </tran:Uitwisselingen>
      </tran:Body>
    </tran:ProcessOpenstaandeUitwisselingen>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('ProcessOpenstaandeUitwisselingen', xml);
  const status = getNodeText(responseText, 'Status') || 'unknown';
  const responseTransactionId = getNodeText(responseText, 'TransactionId') || transactionId;
  return { success: String(status).toLowerCase() === 'completed', status, transactionId: responseTransactionId, raw: responseText };
}
