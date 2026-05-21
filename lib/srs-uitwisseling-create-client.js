/**
 * SRS si_uitwisselingen.php SOAP client — boekt een nieuwe uitwisseling
 * (inter-store transfer) tussen twee filialen.
 *
 * WSDL: https://ws.srs.nl/webservices/si_uitwisselingen.php?wsdl=1
 *
 * Verschil met srs-exchanges-client.js (die alleen LEEST open uitwisselingen):
 * - Andere endpoint (/webservices/si_uitwisselingen.php)
 * - boekUitwisseling-methode voor CREATE
 * - SOAP rpc/encoded style ipv document/literal
 *
 * Credentials: SRS_MESSAGE_USER + SRS_MESSAGE_PASSWORD
 *   (zelfde account als de read-only exchanges-client).
 */

const DEFAULT_BASE_URL = 'https://ws.srs.nl';
const PATH = '/webservices/si_uitwisselingen.php';
const SOAP_TIMEOUT_MS = Number(process.env.SRS_SOAP_TIMEOUT_MS || 20000);

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

function getConfig() {
  const username = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  const baseUrl = (process.env.SRS_BASE_URL || process.env.SRS_MESSAGE_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  if (!username || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken in Vercel Environment Variables.');
  }
  return { username, password, endpoint: `${baseUrl}${PATH}` };
}

function buildBoekUitwisselingXml({ username, password, vanFiliaal, naarFiliaal, referentie, regels }) {
  const regelsXml = regels.map((r) => `
        <regel xsi:type="si:UitwisselRequestRegel">
          <barcode xsi:type="xsd:string">${xmlEscape(r.barcode)}</barcode>
          <aantal xsi:type="xsd:int">${Number(r.aantal) || 0}</aantal>
        </regel>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:xsd="http://www.w3.org/2001/XMLSchema"
  xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
  xmlns:soapenc="http://schemas.xmlsoap.org/soap/encoding/"
  xmlns:si="urn:si_uitwisselingen">
  <soapenv:Header/>
  <soapenv:Body>
    <si:boekUitwisseling soapenv:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <login xsi:type="si:Login">
        <username xsi:type="xsd:string">${xmlEscape(username)}</username>
        <password xsi:type="xsd:string">${xmlEscape(password)}</password>
      </login>
      <uitwisseling xsi:type="si:UitwisselRequest">
        <vanFiliaal xsi:type="xsd:int">${Number(vanFiliaal) || 0}</vanFiliaal>
        <naarFiliaal xsi:type="xsd:int">${Number(naarFiliaal) || 0}</naarFiliaal>
        <referentie xsi:type="xsd:string">${xmlEscape(referentie || '')}</referentie>
        <regels xsi:type="si:ArrayOfUitwisselRequestRegel" soapenc:arrayType="si:UitwisselRequestRegel[${regels.length}]">${regelsXml}
        </regels>
      </uitwisseling>
    </si:boekUitwisseling>
  </soapenv:Body>
</soapenv:Envelope>`;
}

async function postSoap(action, xml, endpoint) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number.isFinite(SOAP_TIMEOUT_MS) && SOAP_TIMEOUT_MS > 0 ? SOAP_TIMEOUT_MS : 20000);
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
 * Boek een uitwisseling in SRS.
 *
 * @param {object} input
 * @param {number} input.vanFiliaal — SRS branchId van afzendend filiaal
 * @param {number} input.naarFiliaal — SRS branchId van ontvangend filiaal
 * @param {string} input.referentie — vrije referentie (max ~50 chars)
 * @param {Array<{barcode:string, aantal:number}>} input.regels
 * @returns {Promise<{success:boolean, status:string, raw:string}>}
 */
export async function boekUitwisseling({ vanFiliaal, naarFiliaal, referentie, regels }) {
  if (!vanFiliaal || !naarFiliaal) throw new Error('vanFiliaal en naarFiliaal zijn verplicht.');
  if (String(vanFiliaal) === String(naarFiliaal)) throw new Error('vanFiliaal en naarFiliaal mogen niet gelijk zijn.');
  if (!Array.isArray(regels) || !regels.length) throw new Error('Minimaal 1 regel is verplicht.');

  /* Normaliseer + valideer regels */
  const normRegels = regels.map((r, i) => {
    const barcode = String(r.barcode || r.sku || '').trim();
    const aantal = Number(r.aantal || r.quantity || 0);
    if (!barcode) throw new Error(`Regel ${i + 1}: barcode is verplicht.`);
    if (!aantal || aantal <= 0) throw new Error(`Regel ${i + 1}: aantal moet > 0 zijn.`);
    return { barcode, aantal };
  });

  const { username, password, endpoint } = getConfig();
  const xml = buildBoekUitwisselingXml({
    username,
    password,
    vanFiliaal,
    naarFiliaal,
    referentie: String(referentie || '').slice(0, 50),
    regels: normRegels
  });

  const responseText = await postSoap('boekUitwisseling', xml, endpoint);
  /* De response bevat <return>OK</return> bij succes. Andere strings duiden op
     een specifieke foutmelding (bv. "ERROR: artikel niet bekend"). */
  const ret = getNodeText(responseText, 'return') || '';
  const isOk = /^OK$/i.test(ret);
  return {
    success: isOk,
    status: ret || 'unknown',
    raw: responseText
  };
}
