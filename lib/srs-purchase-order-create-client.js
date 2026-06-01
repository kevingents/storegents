/**
 * lib/srs-purchase-order-create-client.js
 *
 * Zet een lokaal aangemaakte inkooporder DOOR naar SRS via de PurchaseOrders-
 * webservice (Message user). Geïmplementeerd exact volgens de SRS-documentatie:
 *   https://srs.zendesk.com/hc/nl/articles/360017968117-Webservice-PurchaseOrders
 *   WSDL: https://ws.storeinfo.nl/messages/v1/soap/PurchaseOrders.php?wsdl=1
 *
 * Methodes in deze client: Create (inkooporder aanmaken) en Cancel (annuleren).
 * Receive/ReceiveCorrection (binnenmelden) volgen in de ontvangst-fase.
 *
 * Create-vereisten (uit de doc):
 *  - ConfigurationId  → vooraf met SRS afgesproken (env SRS_PO_CONFIGURATION_ID).
 *  - SupplierId       → SRS-leveranciersid (uit de leveranciers-store, srsId).
 *  - Artikelen moeten al in SRS ERP bestaan (Sku per regel).
 *  - OrderType is optioneel (env SRS_PO_ORDER_TYPE), maar moet in SRS bestaan.
 *
 * ENV:
 *   SRS_PO_CONFIGURATION_ID   verplicht voor doorzetten (zonder → push uit)
 *   SRS_PO_ORDER_TYPE         optioneel
 *   SRS_PO_CREATE_ENABLED     optioneel: zet op '0' om push expliciet uit te zetten
 *   SRS_PO_CREATE_BASE_URL    optioneel endpoint-override (default SRS_BASE_URL → ws.srs.nl)
 *   SRS_MESSAGE_USER/PASSWORD login (zelfde account als GetPurchaseOrders)
 *   SRS_SOAP_TIMEOUT_MS       default 15000
 */

const DEFAULT_BASE_URL = 'https://ws.srs.nl';
const PATH = '/messages/v1/soap/PurchaseOrders.php';
const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 15000);

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getNodeText(xml, tagName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const m = String(xml || '').match(re);
  return m ? m[1].trim() : '';
}

function parseSoapFault(xml) {
  const faultString = getNodeText(xml, 'faultstring') || getNodeText(xml, 'Reason') || getNodeText(xml, 'Text');
  const faultCode = getNodeText(xml, 'faultcode') || getNodeText(xml, 'Code');
  if (!faultString && !faultCode) return null;
  return { code: faultCode, message: faultString || 'SRS SOAP fault' };
}

function genUuid() {
  return (globalThis.crypto?.randomUUID?.())
    || 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.floor(Math.random() * 16);
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
}

function nowStamp() {
  return new Date().toISOString().slice(0, 19); /* yyyy-MM-ddTHH:mm:ss */
}

function getConfigurationId() {
  return String(process.env.SRS_PO_CONFIGURATION_ID || '').trim();
}

export function isPurchaseOrderPushEnabled() {
  const flag = String(process.env.SRS_PO_CREATE_ENABLED || '').trim().toLowerCase();
  if (['0', 'false', 'nee', 'no', 'off'].includes(flag)) return false;
  return Boolean(getConfigurationId());
}

function getConfig() {
  const id = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  const baseUrl = (process.env.SRS_PO_CREATE_BASE_URL || process.env.SRS_BASE_URL || process.env.SRS_MESSAGE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken in Vercel Environment Variables.');
  }
  return { id, password, endpoint: `${baseUrl}${PATH}` };
}

function buildHeaderXml(id, password) {
  return `<tran:Header>
        <com:Login>
          <com:Id>${xmlEscape(id)}</com:Id>
          <com:Password>${xmlEscape(password)}</com:Password>
        </com:Login>
        <com:TransactionId>${genUuid()}</com:TransactionId>
        <com:Timestamp>${nowStamp()}</com:Timestamp>
      </tran:Header>`;
}

function buildItemsXml(lines) {
  return (lines || []).map((l) => {
    const sku = xmlEscape(l.sku || l.barcode || '');
    const price = (Number(l.purchasePrice) || 0).toFixed(2);
    const pieces = Math.max(0, Math.round(Number(l.quantity) || 0));
    return `
          <tran:Item>
            <tran:Sku>${sku}</tran:Sku>
            <tran:PurchasePrice>${price}</tran:PurchasePrice>
            <tran:Pieces>${pieces}</tran:Pieces>
          </tran:Item>`;
  }).join('');
}

function envelope(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/PurchaseOrders/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
${inner}
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function postSoap(action, xml, endpoint) {
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
      const err = new Error(fault?.message || `SRS fout: ${response.status}`);
      err.status = response.status;
      err.fault = fault;
      err.responseText = text;
      throw err;
    }
    return text;
  } catch (err) {
    if (err?.name === 'AbortError') {
      const t = new Error(`SRS timeout na ${SOAP_TIMEOUT_MS}ms (${action}).`);
      t.status = 504;
      throw t;
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/* Gemeenschappelijke response-parse voor Create/Cancel (zelfde vorm). */
function parsePoResponse(responseText) {
  const status = getNodeText(responseText, 'Status'); /* Header/Status: 'completed' */
  return {
    srsOrderNr: getNodeText(responseText, 'OrderNr'),
    orderReference: getNodeText(responseText, 'OrderReference'),
    statusName: getNodeText(responseText, 'Name'),       /* order-status (In nota / Geannuleerd / geleverd) */
    transactionStatus: status || 'completed',
    raw: responseText
  };
}

/* Som van alle voorkomens van een numerieke tag (bv. PiecesReceived) in de XML. */
function sumTag(xml, tagName) {
  const re = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'gi');
  let total = 0;
  for (const m of String(xml || '').matchAll(re)) {
    const n = Number(String(m[1]).trim());
    if (Number.isFinite(n)) total += n;
  }
  return total;
}

function buildReceiveItemsXml(items, { useSku = false } = {}) {
  return (items || []).map((it) => {
    const code = xmlEscape(useSku ? (it.sku || it.barcode || '') : (it.barcode || it.sku || ''));
    const pieces = Math.round(Number(it.pieces ?? it.quantity) || 0);
    const price = it.purchasePrice != null ? `
            <tran:PurchasePrice>${(Number(it.purchasePrice) || 0).toFixed(2)}</tran:PurchasePrice>` : '';
    const tag = useSku ? 'Sku' : 'Barcode';
    return `
          <tran:Item>
            <tran:${tag}>${code}</tran:${tag}>${price}
            <tran:Pieces>${pieces}</tran:Pieces>
          </tran:Item>`;
  }).join('');
}

/**
 * Maak een inkooporder aan in SRS (Create).
 *
 * @param {object} order  order uit inkoop-store (lines[], reference/orderNr, branchId, dates)
 * @param {object} [opts] { srsSupplierId } — SRS-leveranciersid (verplicht)
 * @returns {Promise<{success, srsOrderNr, status, statusName, raw}>}
 * @throws {Error} met code 'PO_PUSH_DISABLED' als ConfigurationId ontbreekt
 */
export async function createPurchaseOrderInSrs(order, { srsSupplierId } = {}) {
  if (!isPurchaseOrderPushEnabled()) {
    const e = new Error(
      'Doorzetten naar SRS kan nog niet: er is geen ConfigurationId ingesteld. Vraag bij SRS ' +
      'een PurchaseOrders-ConfigurationId aan en zet die als SRS_PO_CONFIGURATION_ID in Vercel. ' +
      'De order is wél opgeslagen en kan gemaild worden.'
    );
    e.code = 'PO_PUSH_DISABLED';
    throw e;
  }
  if (!order || !Array.isArray(order.lines) || !order.lines.length) {
    throw new Error('Order zonder regels kan niet worden doorgezet.');
  }
  const supplierId = String(srsSupplierId || order.srsSupplierId || '').trim();
  if (!supplierId) {
    throw new Error('SRS-leveranciersid (SupplierId) ontbreekt. Vul het SRS-id bij de leverancier in.');
  }
  const branchId = String(order.branchId || '').trim();
  if (!branchId) {
    throw new Error('Filiaal (BranchId) ontbreekt op de order.');
  }

  const { id, password, endpoint } = getConfig();
  const orderType = String(process.env.SRS_PO_ORDER_TYPE || '').trim();
  const inner = `    <tran:Create>
      ${buildHeaderXml(id, password)}
      <tran:Body>
        <tran:ConfigurationId>${xmlEscape(getConfigurationId())}</tran:ConfigurationId>
        <tran:SupplierId>${xmlEscape(supplierId)}</tran:SupplierId>${orderType ? `
        <tran:OrderType>${xmlEscape(orderType)}</tran:OrderType>` : ''}
        <tran:OrderReference>${xmlEscape(order.reference || order.orderNr || '')}</tran:OrderReference>
        <tran:BranchId>${xmlEscape(branchId)}</tran:BranchId>
        <tran:Items>${buildItemsXml(order.lines)}
        </tran:Items>
      </tran:Body>
    </tran:Create>`;

  const responseText = await postSoap('Create', envelope(inner), endpoint);
  const parsed = parsePoResponse(responseText);
  return { success: true, status: parsed.transactionStatus, ...parsed };
}

/**
 * Annuleer een bestaande SRS-inkooporder (Cancel) op SRS-ordernummer.
 * @param {string} srsOrderNr
 * @returns {Promise<{success, srsOrderNr, statusName, raw}>}
 */
export async function cancelPurchaseOrderInSrs(srsOrderNr) {
  if (!isPurchaseOrderPushEnabled()) {
    const e = new Error('Annuleren in SRS kan nog niet: ConfigurationId ontbreekt (SRS_PO_CONFIGURATION_ID).');
    e.code = 'PO_PUSH_DISABLED';
    throw e;
  }
  const nr = String(srsOrderNr || '').trim();
  if (!nr) throw new Error('SRS-ordernummer ontbreekt voor annuleren.');
  const { id, password, endpoint } = getConfig();
  const inner = `    <tran:Cancel>
      ${buildHeaderXml(id, password)}
      <tran:Body>
        <tran:OrderNr>${xmlEscape(nr)}</tran:OrderNr>
      </tran:Body>
    </tran:Cancel>`;
  const responseText = await postSoap('Cancel', envelope(inner), endpoint);
  const parsed = parsePoResponse(responseText);
  return { success: true, status: parsed.transactionStatus, ...parsed };
}

/**
 * Meld artikelen binnen op een SRS-inkooporder (Receive). Verhoogt de voorraad,
 * maakt pseudofacturen en verlaagt het aantal in nota.
 *
 * @param {string} srsOrderNr
 * @param {Array<{barcode?:string, sku?:string, pieces:number, purchasePrice?:number}>} items
 * @returns {Promise<{success, srsOrderNr, statusName, piecesOrdered, piecesReceived, raw}>}
 */
export async function receivePurchaseOrderInSrs(srsOrderNr, items) {
  if (!isPurchaseOrderPushEnabled()) {
    const e = new Error('Binnenmelden in SRS kan nog niet: ConfigurationId ontbreekt (SRS_PO_CONFIGURATION_ID).');
    e.code = 'PO_PUSH_DISABLED';
    throw e;
  }
  const nr = String(srsOrderNr || '').trim();
  if (!nr) throw new Error('SRS-ordernummer ontbreekt voor binnenmelden.');
  const list = (items || []).filter((it) => (Number(it.pieces ?? it.quantity) || 0) > 0 && (it.barcode || it.sku));
  if (!list.length) throw new Error('Geen regels met aantal > 0 om binnen te melden.');

  const { id, password, endpoint } = getConfig();
  const inner = `    <tran:Receive>
      ${buildHeaderXml(id, password)}
      <tran:Body>
        <tran:OrderNr>${xmlEscape(nr)}</tran:OrderNr>
        <tran:Items>${buildReceiveItemsXml(list, { useSku: false })}
        </tran:Items>
      </tran:Body>
    </tran:Receive>`;

  const responseText = await postSoap('Receive', envelope(inner), endpoint);
  const parsed = parsePoResponse(responseText);
  return {
    success: true,
    status: parsed.transactionStatus,
    srsOrderNr: parsed.srsOrderNr || nr,
    statusName: parsed.statusName,
    piecesOrdered: sumTag(responseText, 'PiecesOrdered'),
    piecesReceived: sumTag(responseText, 'PiecesReceived'),
    raw: responseText
  };
}

/**
 * Corrigeer een eerdere binnenmelding (ReceiveCorrection). Pieces is het
 * verschil dat erbij/eraf gaat (negatief verlaagt). Werkt op Sku.
 */
export async function receiveCorrectionInSrs(srsOrderNr, items) {
  if (!isPurchaseOrderPushEnabled()) {
    const e = new Error('Correctie binnenmelding kan nog niet: ConfigurationId ontbreekt (SRS_PO_CONFIGURATION_ID).');
    e.code = 'PO_PUSH_DISABLED';
    throw e;
  }
  const nr = String(srsOrderNr || '').trim();
  if (!nr) throw new Error('SRS-ordernummer ontbreekt voor correctie.');
  const list = (items || []).filter((it) => Number(it.pieces ?? it.quantity) !== 0 && (it.sku || it.barcode));
  if (!list.length) throw new Error('Geen correctie-regels.');

  const { id, password, endpoint } = getConfig();
  const inner = `    <tran:ReceiveCorrection>
      ${buildHeaderXml(id, password)}
      <tran:Body>
        <tran:OrderNr>${xmlEscape(nr)}</tran:OrderNr>
        <tran:Items>${buildReceiveItemsXml(list, { useSku: true })}
        </tran:Items>
      </tran:Body>
    </tran:ReceiveCorrection>`;

  const responseText = await postSoap('ReceiveCorrection', envelope(inner), endpoint);
  const parsed = parsePoResponse(responseText);
  return {
    success: true,
    status: parsed.transactionStatus,
    srsOrderNr: parsed.srsOrderNr || nr,
    statusName: parsed.statusName,
    piecesOrdered: sumTag(responseText, 'PiecesOrdered'),
    piecesReceived: sumTag(responseText, 'PiecesReceived'),
    raw: responseText
  };
}
