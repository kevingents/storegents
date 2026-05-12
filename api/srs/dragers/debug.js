import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';

const ENDPOINT = 'https://production.srs.nl/messages/v1/soap/Drager.php';
const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const DATA_NS = 'https://messages.storeinfo.nl/v1/Drager/Data';
const TX_NS = 'https://messages.storeinfo.nl/v1/Drager/Transactions';

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

function env(name, fallback = '') {
  return clean(process.env[name] || fallback);
}

function tag(name, value) {
  const text = clean(value);
  return text ? `<${name}>${escapeXml(text)}</${name}>` : '';
}

function envelope(body) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="${SOAP_NS}" xmlns:drd="${DATA_NS}" xmlns:plt="${TX_NS}">
  <soapenv:Header/>
  <soapenv:Body>${body}</soapenv:Body>
</soapenv:Envelope>`;
}

function authD(prefix = 'drd') {
  const user = env('SRS_DRAGER_USERNAME', env('SRS_USERNAME'));
  const pass = env('SRS_DRAGER_PASSWORD', env('SRS_PASSWORD'));
  const customer = env('SRS_DRAGER_CUSTOMER_CODE', env('SRS_CUSTOMER_CODE'));
  return [
    tag(`${prefix}:UserName`, user),
    tag(`${prefix}:Username`, user),
    tag(`${prefix}:Password`, pass),
    tag(`${prefix}:CustomerCode`, customer),
    tag(`${prefix}:KlantCode`, customer)
  ].join('');
}

function variants(dragerId, store) {
  return [
    { name: 'drd-DragerId', body: `<drd:GetDragerInfo>${authD('drd')}${tag('drd:DragerId', dragerId)}</drd:GetDragerInfo>` },
    { name: 'drd-DragerNummer', body: `<drd:GetDragerInfo>${authD('drd')}${tag('drd:DragerNummer', dragerId)}</drd:GetDragerInfo>` },
    { name: 'drd-Barcode', body: `<drd:GetDragerInfo>${authD('drd')}${tag('drd:Barcode', dragerId)}</drd:GetDragerInfo>` },
    { name: 'drd-Nummer', body: `<drd:GetDragerInfo>${authD('drd')}${tag('drd:Nummer', dragerId)}</drd:GetDragerInfo>` },
    { name: 'no-prefix-DragerId', body: `<drd:GetDragerInfo>${authD('drd')}<DragerId>${escapeXml(dragerId)}</DragerId></drd:GetDragerInfo>` },
    { name: 'nested-Drager-Id', body: `<drd:GetDragerInfo>${authD('drd')}<drd:Drager>${tag('drd:Id', dragerId)}${tag('drd:Nummer', dragerId)}</drd:Drager></drd:GetDragerInfo>` },
    { name: 'with-store', body: `<drd:GetDragerInfo>${authD('drd')}${tag('drd:DragerNummer', dragerId)}${tag('drd:FiliaalNaam', store)}${tag('drd:Filiaal', store)}</drd:GetDragerInfo>` }
  ];
}

function strip(xml = '') {
  return clean(xml).replace(/\s+/g, ' ').slice(0, 1200);
}

async function callVariant(variant) {
  try {
    const response = await fetch(env('SRS_DRAGER_SOAP_ENDPOINT', ENDPOINT), {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: 'https://messages.storeinfo.nl/v1/soap/Drager/GetDragerInfo'
      },
      body: envelope(variant.body),
      signal: AbortSignal.timeout(Number(process.env.SRS_DRAGER_TIMEOUT_MS || 30000))
    });
    const text = await response.text();
    return { name: variant.name, status: response.status, ok: response.ok, response: strip(text) };
  } catch (error) {
    return { name: variant.name, status: 0, ok: false, error: error.message };
  }
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const dragerId = clean(req.query.dragerId || req.query.id || req.query.drager);
  const store = clean(req.query.store || '');
  if (!dragerId) return res.status(400).json({ success: false, message: 'dragerId is verplicht.' });

  const results = [];
  for (const variant of variants(dragerId, store)) {
    results.push(await callVariant(variant));
  }

  return res.status(200).json({
    success: true,
    dragerId,
    store,
    endpoint: env('SRS_DRAGER_SOAP_ENDPOINT', ENDPOINT),
    hasUser: Boolean(env('SRS_DRAGER_USERNAME', env('SRS_USERNAME'))),
    hasPassword: Boolean(env('SRS_DRAGER_PASSWORD', env('SRS_PASSWORD'))),
    hasCustomerCode: Boolean(env('SRS_DRAGER_CUSTOMER_CODE', env('SRS_CUSTOMER_CODE'))),
    results
  });
}
