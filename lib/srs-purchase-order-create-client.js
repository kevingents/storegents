/**
 * lib/srs-purchase-order-create-client.js
 *
 * Zet een lokaal aangemaakte inkooporder DOOR naar SRS (PurchaseOrders-webservice).
 *
 * BELANGRIJK — spec-bevestiging nodig:
 * De exacte "create"-operatie van de SRS PurchaseOrders-webservice staat in de
 * (login-afgeschermde) Zendesk-documentatie:
 *   https://srs.zendesk.com/hc/nl/articles/360017968117-Webservice-PurchaseOrders
 * Wij konden die niet automatisch inlezen. Daarom is dit doorzetten standaard
 * UITGESCHAKELD (SRS_PO_CREATE_ENABLED) en zijn de operatie + veldnamen via
 * env overschrijfbaar, zodat je het kunt aanzetten zónder code te wijzigen zodra
 * de spec bevestigd is. De opbouw volgt dezelfde namespace/vorm als de
 * werkende GetPurchaseOrders (messages.storeinfo.nl/v1/PurchaseOrders/Data).
 *
 * ENV:
 *   SRS_PO_CREATE_ENABLED   '1' om doorzetten te activeren (default: uit)
 *   SRS_PO_CREATE_ACTION    SOAPAction/operatie (default 'AddPurchaseOrder')
 *   SRS_PO_CREATE_PATH      pad (default '/messages/v1/soap/PurchaseOrders.php')
 *   SRS_BASE_URL            default 'https://ws.srs.nl'
 *   SRS_MESSAGE_USER/PASSWORD  login (zelfde account als GetPurchaseOrders)
 *   SRS_SOAP_TIMEOUT_MS     default 15000
 */

const DEFAULT_BASE_URL = 'https://ws.srs.nl';
const DEFAULT_PATH = '/messages/v1/soap/PurchaseOrders.php';
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

export function isPurchaseOrderPushEnabled() {
  const v = String(process.env.SRS_PO_CREATE_ENABLED || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'ja' || v === 'yes';
}

function getConfig() {
  const id = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  const baseUrl = (process.env.SRS_BASE_URL || process.env.SRS_MESSAGE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const path = process.env.SRS_PO_CREATE_PATH || DEFAULT_PATH;
  const action = process.env.SRS_PO_CREATE_ACTION || 'AddPurchaseOrder';
  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken in Vercel Environment Variables.');
  }
  return { id, password, endpoint: `${baseUrl}${path}`, action };
}

function buildProductsXml(lines) {
  return (lines || []).map((l) => `
          <data:Product>
            <data:Barcode>${xmlEscape(l.barcode || l.sku)}</data:Barcode>
            <data:Sku>${xmlEscape(l.sku)}</data:Sku>
            <data:PiecesOrdered>${Math.max(0, Math.round(Number(l.quantity) || 0))}</data:PiecesOrdered>
            <data:PurchasePrice>${(Number(l.purchasePrice) || 0).toFixed(2)}</data:PurchasePrice>
          </data:Product>`).join('');
}

function buildAddPurchaseOrderXml({ id, password, action, order }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/PurchaseOrders/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:${action}>
      <data:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </data:Login>
      <data:Body>
        <data:PurchaseOrder>
          <data:Supplier>
            <data:Id>${xmlEscape(order.srsSupplierId || order.supplierSrsId || '')}</data:Id>
            <data:Name>${xmlEscape(order.supplierName || '')}</data:Name>
          </data:Supplier>
          <data:BranchId>${xmlEscape(order.branchId || '')}</data:BranchId>
          <data:OrderReference>${xmlEscape(order.reference || order.orderNr || '')}</data:OrderReference>
          <data:OrderDate>${xmlEscape(order.orderDate || '')}</data:OrderDate>
          <data:ExpectedDeliveryDate>${xmlEscape(order.expectedDate || '')}</data:ExpectedDeliveryDate>
          <data:Products>${buildProductsXml(order.lines)}
          </data:Products>
        </data:PurchaseOrder>
      </data:Body>
    </data:${action}>
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

/**
 * Zet één inkooporder door naar SRS.
 *
 * @param {object} order  een order uit inkoop-store (lines[], supplier..., branchId, reference, dates)
 * @param {object} [opts] { srsSupplierId } — SRS-leveranciersid (uit de leveranciers-store)
 * @returns {Promise<{success, srsOrderNr, status, raw}>}
 * @throws {Error} met code 'PO_PUSH_DISABLED' als doorzetten nog niet is aangezet
 */
export async function createPurchaseOrderInSrs(order, { srsSupplierId } = {}) {
  if (!isPurchaseOrderPushEnabled()) {
    const e = new Error(
      'Doorzetten naar SRS staat nog uit. Bevestig de PurchaseOrders-create operatie ' +
      '(Zendesk-doc) en zet SRS_PO_CREATE_ENABLED=1 in Vercel. De order is wél opgeslagen ' +
      'en kan gemaild worden.'
    );
    e.code = 'PO_PUSH_DISABLED';
    throw e;
  }
  if (!order || !Array.isArray(order.lines) || !order.lines.length) {
    throw new Error('Order zonder regels kan niet worden doorgezet.');
  }
  const { id, password, endpoint, action } = getConfig();
  const xml = buildAddPurchaseOrderXml({
    id,
    password,
    action,
    order: { ...order, srsSupplierId: srsSupplierId || order.srsSupplierId }
  });
  const responseText = await postSoap(action, xml, endpoint);
  const srsOrderNr = getNodeText(responseText, 'OrderNr') || getNodeText(responseText, 'PurchaseOrderNr') || getNodeText(responseText, 'return') || '';
  return {
    success: true,
    srsOrderNr,
    status: getNodeText(responseText, 'Status') || 'OK',
    raw: responseText
  };
}
