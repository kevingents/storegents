const DEFAULT_ENDPOINT = 'https://production.srs.nl/messages/v1/soap/Drager.php';
const NS_SOAP = 'http://schemas.xmlsoap.org/soap/envelope/';
const NS_DATA = 'https://messages.storeinfo.nl/v1/Drager/Data';
const NS_TX = 'https://messages.storeinfo.nl/v1/Drager/Transactions';
const NS_COMMON = 'https://messages.storeinfo.nl/v1/Common';

function clean(value) {
  return String(value ?? '').trim();
}

function escapeXml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getUser() {
  return clean(process.env.SRS_DRAGER_USERNAME || process.env.SRS_MESSAGE_USER || process.env.SRS_USER || process.env.SRS_USERNAME);
}

function getPassword() {
  return clean(process.env.SRS_DRAGER_PASSWORD || process.env.SRS_MESSAGE_PASSWORD || process.env.SRS_PASSWORD);
}

function tag(name, value) {
  const text = clean(value);
  return text ? `<${name}>${escapeXml(text)}</${name}>` : '';
}

function soapEnvelope(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${NS_SOAP}" xmlns:drd="${NS_DATA}" xmlns:plt="${NS_TX}" xmlns:com="${NS_COMMON}">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
}

function loginBlock(prefix = 'drd') {
  const user = getUser();
  const password = getPassword();
  if (!user || !password) throw new Error('SRS_MESSAGE_USER of SRS_MESSAGE_PASSWORD ontbreekt in Vercel.');
  return `<${prefix}:Login><com:Id>${escapeXml(user)}</com:Id><com:Password>${escapeXml(password)}</com:Password></${prefix}:Login>`;
}

function endpoint() {
  return clean(process.env.SRS_DRAGER_SOAP_ENDPOINT || DEFAULT_ENDPOINT);
}

function bodyText(xml, tagName) {
  const re = new RegExp(`<[^:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^:>]*:?${tagName}>`, 'i');
  const match = clean(xml).match(re);
  return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
}

async function callSoap(action, body) {
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: action
    },
    body: soapEnvelope(body),
    signal: AbortSignal.timeout(Number(process.env.SRS_DRAGER_TIMEOUT_MS || 45000))
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`SRS Drager SOAP ${action} fout ${response.status}: ${text.slice(0, 500)}`);
  const fault = bodyText(text, 'faultstring') || bodyText(text, 'FaultString');
  if (fault) throw new Error(`SRS Drager SOAP ${action}: ${fault}`);
  return text;
}

function parseRowsFromJsonLike(text) {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.dragers)) return parsed.dragers;
    if (Array.isArray(parsed.rows)) return parsed.rows;
    if (Array.isArray(parsed.items)) return parsed.items;
    return [parsed];
  } catch (_error) {
    return [];
  }
}

function parseSimpleDragers(xml) {
  const blocks = clean(xml).match(/<[^:>]*:?Drager\b[\s\S]*?<\/[^:>]*:?Drager>/gi) || [];
  return blocks.map((block) => ({
    dragerId: bodyText(block, 'DragerId') || bodyText(block, 'Id') || bodyText(block, 'Nummer') || bodyText(block, 'Barcode') || bodyText(block, 'CarrierId'),
    store: bodyText(block, 'FiliaalNaam') || bodyText(block, 'Filiaal') || bodyText(block, 'Store') || bodyText(block, 'Winkel') || bodyText(block, 'BranchId'),
    status: bodyText(block, 'Status'),
    createdAt: bodyText(block, 'AangemaaktOp') || bodyText(block, 'CreatedAt') || bodyText(block, 'Datum') || bodyText(block, 'Created'),
    itemCount: bodyText(block, 'AantalArtikelen') || bodyText(block, 'Aantal') || bodyText(block, 'ItemCount'),
    rawXml: block
  })).filter((row) => row.dragerId || row.store || row.status);
}

function parseDragers(xml) {
  const jsonPayload = bodyText(xml, 'Result') || bodyText(xml, 'Data') || bodyText(xml, 'Json') || bodyText(xml, 'Dragers');
  const parsedJson = parseRowsFromJsonLike(jsonPayload);
  if (parsedJson.length) return parsedJson;
  return parseSimpleDragers(xml);
}

function dragerBody(dragerId = '', store = '', branchId = '') {
  return [
    tag('drd:DragerId', dragerId),
    tag('drd:DragerNummer', dragerId),
    tag('drd:CarrierId', dragerId),
    tag('drd:Barcode', dragerId),
    tag('drd:Filiaal', store),
    tag('drd:FiliaalNaam', store),
    tag('drd:BranchId', branchId)
  ].join('');
}

export async function getDragerInfo({ store = '', dragerId = '', branchId = '' } = {}) {
  if (!clean(dragerId)) throw new Error('Drager id is verplicht voor GetDragerInfo.');
  const body = `<drd:GetDragerInfo>${loginBlock('drd')}<drd:Body>${dragerBody(dragerId, store, branchId)}</drd:Body></drd:GetDragerInfo>`;
  const xml = await callSoap('GetDragerInfo', body);
  return { xml, rows: parseDragers(xml) };
}

export async function receiveDrager({ dragerId, store = '', branchId = '', employee = '' } = {}) {
  if (!clean(dragerId)) throw new Error('Drager id is verplicht.');
  const body = `<plt:ReceiveDrager>${loginBlock('plt')}<plt:Body>${tag('plt:DragerId', dragerId)}${tag('plt:DragerNummer', dragerId)}${tag('plt:Barcode', dragerId)}${tag('plt:Filiaal', store)}${tag('plt:FiliaalNaam', store)}${tag('plt:BranchId', branchId)}${tag('plt:Employee', employee)}</plt:Body></plt:ReceiveDrager>`;
  const xml = await callSoap('ReceiveDrager', body);
  return {
    xml,
    status: bodyText(xml, 'Status') || bodyText(xml, 'Code') || 'ok',
    message: bodyText(xml, 'Message') || bodyText(xml, 'Omschrijving') || bodyText(xml, 'Description') || ''
  };
}

export async function putInDrager({ dragerId, itemId, barcode, quantity = 1, store = '', branchId = '' } = {}) {
  if (!clean(dragerId)) throw new Error('Drager id is verplicht.');
  const body = `<plt:PutInDrager>${loginBlock('plt')}<plt:Body>${tag('plt:DragerId', dragerId)}${tag('plt:DragerNummer', dragerId)}${tag('plt:ArtikelId', itemId)}${tag('plt:Barcode', barcode)}${tag('plt:Aantal', quantity)}${tag('plt:Filiaal', store)}${tag('plt:BranchId', branchId)}</plt:Body></plt:PutInDrager>`;
  const xml = await callSoap('PutInDrager', body);
  return {
    xml,
    status: bodyText(xml, 'Status') || bodyText(xml, 'Code') || 'ok',
    message: bodyText(xml, 'Message') || bodyText(xml, 'Omschrijving') || bodyText(xml, 'Description') || ''
  };
}
