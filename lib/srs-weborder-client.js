import { getCachedSession, invalidateSession, isSessionError } from './srs-api-session.js';

const DEFAULT_SRS_API_BASE_URL = 'https://ws.srs.nl';
const WEBORDER_PATH = '/webservices/si_weborder.php';
const SRS_SESSION_KEY = 'si_weborder';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function cdata(value) {
  return `<![CDATA[${String(value ?? '').replaceAll(']]>', ']]]]><![CDATA[>')}]]>`;
}

function getApiConfig() {
  const user = process.env.SRS_API_USER || process.env.SRS_API_USERNAME || '';
  const password = process.env.SRS_API_PASSWORD || '';
  const baseUrl = (process.env.SRS_API_BASE_URL || process.env.SRS_BASE_URL || DEFAULT_SRS_API_BASE_URL).replace(/\/$/, '');

  if (!user || !password) {
    throw new Error('SRS_API_USER en/of SRS_API_PASSWORD ontbreken.');
  }

  return {
    user,
    password,
    endpoint: `${baseUrl}${WEBORDER_PATH}`
  };
}

function getNodeText(xml, tagName) {
  const regex = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`, 'i');
  const match = String(xml || '').match(regex);
  return match ? match[1].trim() : '';
}

function parseSoapFault(xml) {
  const faultString = getNodeText(xml, 'faultstring') || getNodeText(xml, 'message') || getNodeText(xml, 'Text');
  const faultCode = getNodeText(xml, 'faultcode') || getNodeText(xml, 'code');

  if (!faultString && !faultCode) return null;

  return {
    code: faultCode,
    message: faultString || 'SRS SOAP fault'
  };
}

const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 20000);

async function postSoap(action, xml) {
  const { endpoint } = getApiConfig();
  const controller = new AbortController();
  const timeout = Number.isFinite(SOAP_TIMEOUT_MS) && SOAP_TIMEOUT_MS > 0 ? SOAP_TIMEOUT_MS : 20000;
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: action
      },
      body: xml,
      signal: controller.signal
    });

    const text = await response.text();
    const fault = parseSoapFault(text);

    if (!response.ok || fault) {
      const error = new Error(fault?.message || `SRS weborder fout: ${response.status}`);
      error.status = response.status;
      error.fault = fault;
      error.responseText = text;
      throw error;
    }

    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`SRS weborder timeout na ${timeout}ms (${action}).`);
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Geef een (gecachede) SRS API session_id voor si_weborder terug.
 * Cache TTL = 20 min (van de 24 min die SRS hanteert).
 */
export async function getCachedWeborderSession() {
  return getCachedSession(SRS_SESSION_KEY, srsApiLogin);
}

export function invalidateSrsWeborderSession() {
  invalidateSession(SRS_SESSION_KEY);
}

async function srsLoginWith(userId, password) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_webshop.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:Login soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <user_id xsi:type="xsd:string">${xmlEscape(userId)}</user_id>
      <password xsi:type="xsd:string">${xmlEscape(password)}</password>
    </si:Login>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('Login', xml);
  const sessionId = getNodeText(responseText, 'return');

  if (!sessionId) {
    throw new Error(`SRS login (user ${userId}) gaf geen session_id terug.`);
  }

  return sessionId;
}

export async function srsApiLogin() {
  const { user, password } = getApiConfig();
  return srsLoginWith(user, password);
}

/**
 * Login als een ALTERNATIEVE SRS-user met hetzelfde (server-side) wachtwoord.
 * Reden: de SRS-login bepaalt in welke WEBSHOP een OrderPlaced terechtkomt. De
 * default-user plaatst in webshop 90 (GENTS Webshop); een dedicated Bol-user
 * (bv. Bol_1088) plaatst in webshop 91 (GENTS Webshop Bol). Het wachtwoord komt
 * uit SRS_API_PASSWORD — nooit uit de request — zodat er geen secret lekt.
 */
export async function srsApiLoginAs(userId) {
  const { password } = getApiConfig();
  const u = String(userId || '').trim();
  if (!u) throw new Error('srsApiLoginAs: userId ontbreekt.');
  return srsLoginWith(u, password);
}

/** Gecachede weborder-sessie voor een specifieke user (leeg = default-user). */
export async function getCachedWeborderSessionForUser(userId) {
  const u = String(userId || '').trim();
  if (!u) return getCachedWeborderSession();
  return getCachedSession(`${SRS_SESSION_KEY}:${u.toLowerCase()}`, () => srsApiLoginAs(u));
}

/** Invalidateer de sessie van een specifieke user (leeg = default-user). */
export function invalidateWeborderSessionForUser(userId) {
  const u = String(userId || '').trim();
  invalidateSession(u ? `${SRS_SESSION_KEY}:${u.toLowerCase()}` : SRS_SESSION_KEY);
}

function splitStreetAndHouseNumber(inputStreet, inputHouseNumber) {
  if (inputHouseNumber) {
    return {
      street: inputStreet || '',
      houseNumber: inputHouseNumber || ''
    };
  }

  const raw = String(inputStreet || '').trim();
  const match = raw.match(/^(.+?)\s+([0-9]+[a-zA-Z0-9\-\/]*)$/);

  if (!match) {
    return {
      street: raw,
      houseNumber: ''
    };
  }

  return {
    street: match[1],
    houseNumber: match[2]
  };
}

function formatAmount(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) ? number.toFixed(2) : '0.00';
}

function createOrderId(prefix = 'W') {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 5).toUpperCase();
  return `${prefix}${stamp}${random}`.slice(0, 15);
}

function addressXml(tagName, address) {
  const parsed = splitStreetAndHouseNumber(address.street, address.houseNumber);

  return `
  <${tagName}>
    <name>${xmlEscape(String(address.name || '').slice(0, 25))}</name>
    <street>${xmlEscape(parsed.street)}</street>
    <housenumber>${xmlEscape(parsed.houseNumber)}</housenumber>
    ${address.address2 ? `<address>${xmlEscape(address.address2)}</address>` : ''}
    <postalcode>${xmlEscape(address.postalCode || '')}</postalcode>
    <city>${xmlEscape(address.city || '')}</city>
    <country>${xmlEscape(address.country || 'NL')}</country>
  </${tagName}>`;
}

function productXml(product) {
  const quantity = Math.max(1, Number(product.quantity || 1));
  const lines = [];

  // SRS adviseert bij meerdere stuks productregels te herhalen met quantity 1.
  for (let i = 0; i < quantity; i += 1) {
    lines.push(`
    <product>
      <product_sku>${xmlEscape(product.sku)}</product_sku>
      <product_name>${xmlEscape(product.name || product.sku)}</product_name>
      <product_quantity>1</product_quantity>
      <product_price>${formatAmount(product.price)}</product_price>
      <tax_perc>${formatAmount(product.taxPerc || 21)}</tax_perc>
    </product>`);
  }

  return lines.join('\n');
}

function extendedAttributeXml(name, value) {
  if (value === undefined || value === null || value === '') return '';

  return `
    <extended_attribute>
      <name>${xmlEscape(name)}</name>
      <value>${xmlEscape(value)}</value>
    </extended_attribute>`;
}

export function buildInterstoreWeborderXml(input) {
  const orderId = input.orderId || createOrderId(process.env.SRS_WEBORDER_PREFIX || 'W');
  const billing = input.billing || input.customer || {};
  const delivery = input.delivery || input.customer || {};
  const product = input.product || {};

  const productTotal = Number(product.price || 0) * Math.max(1, Number(product.quantity || 1));
  const shippingCost = Number(input.shippingCost || 0);
  const total = productTotal + shippingCost;

  const sellingAttr = process.env.SRS_WEBORDER_REVENUE_BRANCH_ATTRIBUTE || 'verkoop_filiaal';
  const fulfilmentAttr = process.env.SRS_WEBORDER_FULFILMENT_BRANCH_ATTRIBUTE || 'afhaal_filiaal';
  const sourceAttr = process.env.SRS_WEBORDER_CREATED_BY_ATTRIBUTE || 'aangemaakt_in_filiaal';

  const extendedAttributes = [
    extendedAttributeXml(sellingAttr, input.sellingBranchId),
    extendedAttributeXml(fulfilmentAttr, input.fulfilmentBranchId),
    extendedAttributeXml(sourceAttr, input.sellingBranchId),
    extendedAttributeXml('verzend_filiaal', input.fulfilmentBranchId),
    extendedAttributeXml('weborder_type', 'winkel_naar_winkel'),
    extendedAttributeXml('opmerking', input.note || '')
  ].join('');

  const misc = shippingCost > 0
    ? `
    <misc>
      <type>${xmlEscape(process.env.SRS_WEBORDER_SHIPPING_MISC_TYPE || '2')}</type>
      <description>${xmlEscape(process.env.SRS_WEBORDER_SHIPPING_DESCRIPTION || 'Verzendkosten')}</description>
      <price>${formatAmount(shippingCost)}</price>
    </misc>`
    : '';

  const paymentType = input.paymentType || process.env.SRS_WEBORDER_PAYMENT_TYPE || 'eft';

  const orderXml = `<order>
  <shopid>${xmlEscape(process.env.SRS_WEBORDER_SHOP_ID || '10')}</shopid>
  <orderid>${xmlEscape(orderId)}</orderid>
  ${input.sellerId ? `<seller_id>${xmlEscape(input.sellerId)}</seller_id>` : ''}
  ${input.customerId ? `<customer_id>${xmlEscape(input.customerId)}</customer_id>` : '<crm_link>true</crm_link>'}
  <date_time>${xmlEscape(input.dateTime || new Date().toISOString().slice(0, 16).replace('T', ' '))}</date_time>
  ${addressXml('billing', billing)}
  ${addressXml('delivery', delivery)}
  <contact>
    <email>${xmlEscape(input.email || billing.email || '')}</email>
    <phone>${xmlEscape(input.phone || billing.phone || '')}</phone>
    <mobile>${xmlEscape(input.mobile || billing.mobile || input.phone || billing.phone || '')}</mobile>
  </contact>
  <orderinfo>
    ${productXml(product)}
    ${misc}
  </orderinfo>
  <payments>
    <payment>
      <type>${xmlEscape(paymentType)}</type>
      <amount>${formatAmount(total)}</amount>
    </payment>
  </payments>
  <extended_attributes>
    ${extendedAttributes}
  </extended_attributes>
</order>`;

  return {
    orderId,
    orderXml,
    total
  };
}

async function placeInterstoreWeborderWithSession(sessionId, built) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_weborder.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:OrderPlaced soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(sessionId)}</session_id>
      <order_xml xsi:type="xsd:string">${cdata(built.orderXml)}</order_xml>
    </si:OrderPlaced>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('OrderPlaced', xml);
  const returned = getNodeText(responseText, 'return');

  if (String(returned).toLowerCase() !== 'true' && returned !== '1') {
    throw new Error(`SRS weborder is niet aangemaakt. Response: ${returned || responseText.slice(0, 300)}`);
  }

  return { responseText, returned };
}

/**
 * Bouw een si_weborder XML voor een RESERVERING.
 *
 * Verschil met buildInterstoreWeborderXml:
 *   - Order-prefix 'R' (zichtbaar als reservering in SRS)
 *   - extended_attribute weborder_type = 'reservering'
 *   - extended_attribute reservering_id = ons interne id
 *   - extended_attribute afhaal_filiaal = RES-branchId
 *   - <payments> WORDT WEGGELATEN — open weborder, klant betaalt bij ophalen
 *   - Optioneel <misc> overgeslagen (geen verzendkosten)
 *
 * @param {object} input
 * @param {string} input.orderId                  Optioneel, anders gegenereerd
 * @param {string|number} input.customerId        SRS klantnummer (optioneel)
 * @param {string|number} input.fulfilmentBranchId RES-branchId waar artikel komt te hangen
 * @param {string|number} [input.sellingBranchId] Winkel-branchId waar reservering aangemaakt is
 * @param {object} input.product   { sku, name, price, quantity, taxPerc }
 * @param {object} input.billing   { name, street, houseNumber, postalCode, city, country }
 * @param {object} [input.delivery] Default = billing
 * @param {string} [input.email]
 * @param {string} [input.phone]
 * @param {string} [input.reserveringId] Voor traceability terug naar Blob-record
 * @param {string} [input.note]
 */
export function buildReserveringWeborderXml(input) {
  const orderId = input.orderId || createOrderId(process.env.SRS_RESERVERING_ORDER_PREFIX || 'R');
  const billing = input.billing || input.customer || {};
  const delivery = input.delivery || billing;
  const product = input.product || {};

  /* Extended attributes worden door SRS afgewezen als ze niet vooraf
     geconfigureerd zijn (SRS error 140 "Problem adding order extended
     attribute"). Default: alleen afhaal_filiaal (essentieel voor RES-
     routing). Via env SRS_RESERVERING_ATTRS kun je een komma-lijst
     opgeven van welke attrs SRS accepteert, bv:
        SRS_RESERVERING_ATTRS=afhaal_filiaal,verkoop_filiaal,opmerking
     Zet leeg om GEEN extended_attributes te sturen. */
  /* Default: GEEN extended_attributes — SRS GENTS-config heeft de meeste
     namen niet geregistreerd (error 140). Routing naar RES-filiaal gaat
     post-place via SetFulfillments. Admin kan ze via env weer aanzetten:
     SRS_RESERVERING_ATTRS=afhaal_filiaal,opmerking */
  const allowedAttrs = String(process.env.SRS_RESERVERING_ATTRS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const fulfilmentAttr = process.env.SRS_WEBORDER_FULFILMENT_BRANCH_ATTRIBUTE || 'afhaal_filiaal';
  const sellingAttr = process.env.SRS_WEBORDER_REVENUE_BRANCH_ATTRIBUTE || 'verkoop_filiaal';
  const sourceAttr = process.env.SRS_WEBORDER_CREATED_BY_ATTRIBUTE || 'aangemaakt_in_filiaal';

  const attrPool = {
    [fulfilmentAttr]: input.fulfilmentBranchId,
    [sellingAttr]: input.sellingBranchId,
    [sourceAttr]: input.sellingBranchId,
    verzend_filiaal: input.fulfilmentBranchId,
    weborder_type: 'reservering',
    reservering_id: input.reserveringId || '',
    opmerking: input.note || 'Reservering via GENTS portaal'
  };

  const extendedAttributes = allowedAttrs
    .map((name) => attrPool[name] !== undefined ? extendedAttributeXml(name, attrPool[name]) : '')
    .filter(Boolean)
    .join('');

  /* Wanneer geen extended_attributes, leeg blok skippen ipv <extended_attributes></> */
  const extendedAttributesXml = extendedAttributes
    ? `<extended_attributes>${extendedAttributes}</extended_attributes>`
    : '';

  /* Open weborder: geen <payments>-blok. SRS accepteert dit voor "open"
     weborders die later bij ophalen via POS afgerekend worden. */
  const orderXml = `<order>
  <shopid>${xmlEscape(process.env.SRS_WEBORDER_SHOP_ID || '10')}</shopid>
  <orderid>${xmlEscape(orderId)}</orderid>
  ${input.sellerId ? `<seller_id>${xmlEscape(input.sellerId)}</seller_id>` : ''}
  ${input.customerId ? `<customer_id>${xmlEscape(input.customerId)}</customer_id>` : '<crm_link>true</crm_link>'}
  <date_time>${xmlEscape(input.dateTime || new Date().toISOString().slice(0, 16).replace('T', ' '))}</date_time>
  ${addressXml('billing', billing)}
  ${addressXml('delivery', delivery)}
  <contact>
    <email>${xmlEscape(input.email || billing.email || '')}</email>
    <phone>${xmlEscape(input.phone || billing.phone || '')}</phone>
    <mobile>${xmlEscape(input.mobile || billing.mobile || input.phone || billing.phone || '')}</mobile>
  </contact>
  <orderinfo>
    ${productXml(product)}
  </orderinfo>
  ${extendedAttributesXml}
</order>`;

  return {
    orderId,
    orderXml,
    total: Number(product.price || 0) * Math.max(1, Number(product.quantity || 1))
  };
}

/**
 * Plaats een reservering als weborder in SRS. Werkt met dezelfde
 * sessie-/retry-pattern als placeInterstoreWeborder.
 */
export async function placeReserveringAsWeborder(input) {
  const built = buildReserveringWeborderXml(input);

  async function attempt(sessionId) {
    const { responseText, returned } = await placeInterstoreWeborderWithSession(sessionId, built);
    return {
      success: true,
      orderId: built.orderId,
      total: built.total,
      srsReturn: returned,
      raw: responseText
    };
  }

  if (input.sessionId) return attempt(input.sessionId);
  try {
    const sessionId = await getCachedWeborderSession();
    return await attempt(sessionId);
  } catch (error) {
    if (!isSessionError(error)) throw error;
    invalidateSession(SRS_SESSION_KEY);
    const fresh = await getCachedWeborderSession();
    return attempt(fresh);
  }
}

export async function placeInterstoreWeborder(input) {
  const built = buildInterstoreWeborderXml(input);

  async function attempt(sessionId) {
    const { responseText, returned } = await placeInterstoreWeborderWithSession(sessionId, built);
    return {
      success: true,
      orderId: built.orderId,
      total: built.total,
      srsReturn: returned,
      raw: responseText
    };
  }

  /* Externe caller mag een sessie meegeven; anders gebruiken we de cache. */
  if (input.sessionId) {
    return attempt(input.sessionId);
  }

  try {
    const sessionId = await getCachedWeborderSession();
    return await attempt(sessionId);
  } catch (error) {
    if (!isSessionError(error)) throw error;
    invalidateSession(SRS_SESSION_KEY);
    const fresh = await getCachedWeborderSession();
    return attempt(fresh);
  }
}
