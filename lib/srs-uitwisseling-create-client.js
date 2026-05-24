/**
 * SRS si_uitwisselingen.php SOAP client — boekt een nieuwe uitwisseling
 * (inter-store transfer) tussen twee filialen.
 *
 * BELANGRIJK: deze "boekUitwisseling" methode zit NIET in de gedocumenteerde
 * Webservice Uitwisseling (die heeft alleen GetAll + Process). Het is een
 * apart endpoint dat door winkelkassa's wordt gebruikt om uitwisselingen
 * aan te maken. Vereist mogelijk per-filiaal Sales user credentials (user10
 * voor filiaal 10, etc.).
 *
 * Configureerbaar via SRS_UITWISSEL_BASE_URL (default storeinfo.nl).
 */

const DEFAULT_BASE_URL = 'https://ws.storeinfo.nl';
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

/**
 * Bepaal credentials voor het boek-uitwisseling endpoint. Volgorde:
 *
 *   1. Per-filiaal in SRS_UITWISSEL_CREDS_JSON:
 *      { "10": { "user": "user10", "password": "..." }, "11": {...} }
 *      → Dit is hoe SRS in productie werkt: elke filiaal heeft eigen account.
 *
 *   2. Globaal SRS_UITWISSEL_USER + SRS_UITWISSEL_PASSWORD
 *      → Voor accounts die OVER ALLE filialen kunnen boeken.
 *
 *   3. Fallback SRS_MESSAGE_USER + SRS_MESSAGE_PASSWORD
 *      → Alleen als dit account ook write-rechten heeft.
 */
function getAllConfigs(vanFiliaal) {
  /* Base URL — probeer alle gebruikte env-namen */
  const baseUrl = (
    process.env.SRS_UITWISSEL_BASE_URL ||
    process.env.SRS_API_BASE_URL ||
    process.env.SRS_BASE_URL ||
    process.env.SRS_MESSAGE_BASE_URL ||
    DEFAULT_BASE_URL
  ).replace(/\/$/, '');
  const endpoint = `${baseUrl}${PATH}`;
  const configs = [];

  /* 1. Dedicated UITWISSELINGEN credentials (door GENTS specifiek gezet) */
  const dedUser = process.env.SRS_API_USER_UITWISSELINGEN || '';
  const dedPass = process.env.SRS_API_PASS_UITWISSELINGEN || process.env.SRS_API_PASSWORD_UITWISSELINGEN || '';
  if (dedUser && dedPass) {
    configs.push({ username: dedUser, password: dedPass, endpoint, source: 'api-uitwisselingen' });
  }

  /* 2. Per-filiaal credentials uit SRS_UITWISSEL_CREDS_JSON */
  const credsJsonRaw = process.env.SRS_UITWISSEL_CREDS_JSON || '';
  if (credsJsonRaw && vanFiliaal) {
    try {
      const map = JSON.parse(credsJsonRaw);
      const entry = map?.[String(vanFiliaal)] || map?.[Number(vanFiliaal)];
      if (entry && entry.user && entry.password) {
        configs.push({ username: entry.user, password: entry.password, endpoint, source: `per-filiaal-${vanFiliaal}` });
      }
    } catch (err) {
      console.warn('[srs-uitwisseling-create] SRS_UITWISSEL_CREDS_JSON parse error:', err.message);
    }
  }

  /* 3. Global UITWISSEL credentials */
  const upUser = process.env.SRS_UITWISSEL_USER || '';
  const upPass = process.env.SRS_UITWISSEL_PASSWORD || '';
  if (upUser && upPass) {
    configs.push({ username: upUser, password: upPass, endpoint, source: 'global-uitwissel' });
  }

  /* 4. MESSAGE credentials (legacy) */
  const mUser = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const mPass = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  if (mUser && mPass) {
    configs.push({ username: mUser, password: mPass, endpoint, source: 'message-fallback' });
  }

  /* 5. Generic API credentials (zelfde als weborders) */
  const apiUser = process.env.SRS_API_USER || process.env.SRS_API_USERNAME || '';
  const apiPass = process.env.SRS_API_PASSWORD || '';
  if (apiUser && apiPass) {
    configs.push({ username: apiUser, password: apiPass, endpoint, source: 'api-generic' });
  }

  if (!configs.length) {
    throw new Error(
      'Geen SRS uitwisseling-credentials ingesteld. Vul in Vercel óf ' +
      'SRS_API_USER_UITWISSELINGEN + SRS_API_PASS_UITWISSELINGEN, óf SRS_UITWISSEL_CREDS_JSON, ' +
      'óf SRS_API_USER + SRS_API_PASSWORD.'
    );
  }
  return configs;
}

/* Backwards-compat: oude getConfig returnt eerste optie. */
function getConfig(vanFiliaal) {
  return getAllConfigs(vanFiliaal)[0];
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

  /* Probeer ALLE beschikbare credential-sets — bij "Login has failed"
     proberen we de volgende. Stopt bij eerste succes of bij andere fout. */
  const configs = getAllConfigs(vanFiliaal);
  let lastRet = '';
  let lastSource = '';
  let lastResponseText = '';
  const triedSources = [];

  for (const cfg of configs) {
    const { username, password, endpoint, source } = cfg;
    triedSources.push(source);
    const xml = buildBoekUitwisselingXml({
      username,
      password,
      vanFiliaal,
      naarFiliaal,
      referentie: String(referentie || '').slice(0, 100),
      regels: normRegels
    });

    let responseText;
    try {
      responseText = await postSoap('boekUitwisseling', xml, endpoint);
    } catch (err) {
      /* Netwerk/timeout fout → throw direct, retry heeft geen zin */
      throw err;
    }

    const ret = getNodeText(responseText, 'return') || '';
    lastRet = ret;
    lastSource = source;
    lastResponseText = responseText;

    /* Succes? Return direct. */
    if (/^OK$/i.test(ret)) {
      return {
        success: true,
        status: ret,
        credSource: source,
        triedSources,
        raw: responseText
      };
    }

    /* Login-fout? Probeer volgende credential-set. Andere fout? Stop. */
    const isLoginFail = /login.*failed|authentication|not authorized|invalid.*credentials/i.test(ret);
    if (!isLoginFail) {
      /* Inhoudelijke fout (bv. 'artikel niet bekend') — geen zin om andere
         credentials te proberen want hetzelfde resultaat. */
      break;
    }
  }

  /* Geen enkele set werkte. Return laatste status. */
  return {
    success: false,
    status: lastRet || 'unknown',
    credSource: lastSource,
    triedSources,
    raw: lastResponseText
  };
}
