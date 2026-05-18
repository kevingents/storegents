import { getCachedSession, invalidateSession, isSessionError } from './srs-api-session.js';

const DEFAULT_SRS_API_BASE_URL = 'https://ws.storeinfo.nl';
const POINTS_SERVICE_PATH = '/webservices/si_spaarpunten.php';
const SRS_SESSION_KEY = 'si_spaarpunten';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getConfig() {
  const user = process.env.SRS_API_USER || process.env.SRS_POINTS_API_USER || '';
  const password = process.env.SRS_API_PASSWORD || process.env.SRS_POINTS_API_PASSWORD || '';
  const baseUrl = (process.env.SRS_API_BASE_URL || process.env.SRS_BASE_URL || DEFAULT_SRS_API_BASE_URL).replace(/\/$/, '');

  if (!user || !password) {
    throw new Error('SRS_API_USER en/of SRS_API_PASSWORD ontbreken.');
  }

  return {
    user,
    password,
    endpoint: `${baseUrl}${POINTS_SERVICE_PATH}`
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
    const error = new Error(fault?.message || `SRS spaarpunten fout: ${response.status}`);
    error.status = response.status;
    error.fault = fault;
    error.responseText = text;
    throw error;
  }

  return text;
}

export async function loginSrsPointsService() {
  const { user, password } = getConfig();

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_spaarpunten.php">
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
    throw new Error('SRS gaf geen session_id terug voor spaarpunten.');
  }

  return sessionId;
}

async function getSession(sessionId) {
  if (sessionId) return sessionId;
  return getCachedSession(SRS_SESSION_KEY, loginSrsPointsService);
}

/**
 * Roep een SRS spaarpunten-call uit met automatische session-retry.
 * Als SRS de session als verlopen markeert, doen we 1 retry met verse login.
 */
async function callWithSession(invoke) {
  const session = await getSession('');
  try {
    return await invoke(session);
  } catch (error) {
    if (!isSessionError(error)) throw error;
    invalidateSession(SRS_SESSION_KEY);
    const fresh = await getSession('');
    return invoke(fresh);
  }
}

export function invalidateSrsPointsSession() {
  invalidateSession(SRS_SESSION_KEY);
}

function parseBalance(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];

  const parts = value.split(';').map((part) => part.trim());

  if (parts.length === 1) {
    const balance = Number(parts[0] || 0);
    return [{ customerId: '', balance: Number.isFinite(balance) ? balance : 0 }];
  }

  const balances = [];

  for (let i = 0; i < parts.length - 1; i += 2) {
    const customerId = parts[i] || '';
    const balance = Number(parts[i + 1] || 0);
    if (customerId) {
      balances.push({
        customerId: customerId.replace(/^0+(?=\d)/, ''),
        originalCustomerId: customerId,
        balance: Number.isFinite(balance) ? balance : 0
      });
    }
  }

  return balances;
}

export async function getPointsBalance({
  customerFrom = '',
  customerTo = '',
  dateFrom = '2000-01-01',
  dateTo = new Date().toISOString().slice(0, 10),
  sessionId = ''
} = {}) {
  const session = await getSession(sessionId);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_spaarpunten.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:getBalance soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <klantnr xsi:type="xsd:string">${xmlEscape(customerFrom)}</klantnr>
      <klantnrtot xsi:type="xsd:string">${xmlEscape(customerTo)}</klantnrtot>
      <datumvan xsi:type="xsd:string">${xmlEscape(dateFrom)}</datumvan>
      <datumtot xsi:type="xsd:string">${xmlEscape(dateTo)}</datumtot>
    </si:getBalance>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('getBalance', xml);
  const raw = getReturnText(responseText);

  return {
    raw,
    balances: parseBalance(raw)
  };
}

function parseDutchDate(value) {
  const match = String(value || '').match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return '';
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function parseMutations(raw) {
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(';');
      const customerId = String(parts[0] || '').trim();
      return {
        customerId: customerId.replace(/^0+(?=\d)/, ''),
        originalCustomerId: customerId,
        date: parseDutchDate(parts[1] || ''),
        time: String(parts[2] || '').trim(),
        points: Number(parts[4] || 0),
        branchId: String(parts[5] || '').trim(),
        departmentId: String(parts[6] || '').trim(),
        raw: line
      };
    })
    .filter((mutation) => mutation.customerId);
}

export async function getPointsMutations({
  customerFrom = '',
  customerTo = '',
  dateFrom,
  dateTo = new Date().toISOString().slice(0, 10),
  sessionId = ''
} = {}) {
  const session = await getSession(sessionId);
  const finalDateFrom = dateFrom || new Date(Date.now() - 1000 * 60 * 60 * 24 * 90).toISOString().slice(0, 10);

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_spaarpunten.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:getMutaties soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <klantnr xsi:type="xsd:string">${xmlEscape(customerFrom)}</klantnr>
      <klantnrtot xsi:type="xsd:string">${xmlEscape(customerTo)}</klantnrtot>
      <datumvan xsi:type="xsd:string">${xmlEscape(finalDateFrom)}</datumvan>
      <datumtot xsi:type="xsd:string">${xmlEscape(dateTo)}</datumtot>
    </si:getMutaties>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('getMutaties', xml);
  const raw = getReturnText(responseText);

  return {
    raw,
    mutations: parseMutations(raw)
  };
}

export async function changePoints({
  customerId,
  action = 'redeem',
  points,
  sender = process.env.SRS_POINTS_SENDER || 'Webshop',
  branchId = process.env.SRS_POINTS_BRANCH_ID || process.env.SRS_WEBSHOP_BRANCH_ID || '0',
  departmentId = process.env.SRS_POINTS_DEPARTMENT_ID || '0',
  date = new Date().toISOString().slice(0, 10),
  time = new Date().toTimeString().slice(0, 8),
  sessionId = ''
} = {}) {
  const session = await getSession(sessionId);
  const safePoints = Math.abs(Math.round(Number(points || 0)));

  if (!customerId) throw new Error('SRS klantnummer ontbreekt voor changePoints.');
  if (!safePoints) throw new Error('Aantal spaarpunten ontbreekt voor changePoints.');
  if (!['issue', 'redeem'].includes(String(action))) throw new Error('changePoints actie moet issue of redeem zijn.');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:si="https://www.storeinfo.nl/webservices/si_spaarpunten.php">
  <soapenv:Header/>
  <soapenv:Body>
    <si:changePoints soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <session_id xsi:type="xsd:string">${xmlEscape(session)}</session_id>
      <klantnr xsi:type="xsd:string">${xmlEscape(customerId)}</klantnr>
      <zender xsi:type="xsd:string">${xmlEscape(sender)}</zender>
      <fil_id xsi:type="xsd:string">${xmlEscape(branchId)}</fil_id>
      <afd_id xsi:type="xsd:string">${xmlEscape(departmentId)}</afd_id>
      <datum xsi:type="xsd:string">${xmlEscape(date)}</datum>
      <tijd xsi:type="xsd:string">${xmlEscape(time)}</tijd>
      <aktie xsi:type="xsd:string">${xmlEscape(action)}</aktie>
      <punten xsi:type="xsd:string">${xmlEscape(safePoints)}</punten>
    </si:changePoints>
  </soapenv:Body>
</soapenv:Envelope>`;

  const responseText = await postSoap('changePoints', xml);
  const raw = getReturnText(responseText);
  const parts = raw.split(';').map((part) => part.trim());

  return {
    raw,
    ok: String(parts[0] || '').toLowerCase() === 'ok',
    action: parts[1] || action,
    customerId: parts[2] || customerId,
    balanceAfter: Number(parts[3] || 0),
    points: safePoints
  };
}

export function getLatestBranchByCustomer(mutations = []) {
  const map = new Map();

  mutations.forEach((mutation) => {
    if (!mutation.customerId) return;
    const current = map.get(mutation.customerId);
    const sortValue = `${mutation.date || ''}T${mutation.time || ''}`;
    const currentSortValue = current ? `${current.date || ''}T${current.time || ''}` : '';

    if (!current || sortValue >= currentSortValue) {
      map.set(mutation.customerId, mutation);
    }
  });

  return map;
}
