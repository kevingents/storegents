import { getSrsBranchMap } from './srs-branches.js';

const PERSONNEL_ENDPOINT = process.env.SRS_PERSONNEL_ENDPOINT || 'https://ws.storeinfo.nl/messages/v1/soap/Personnel.php';

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function stripCdata(value) {
  return String(value || '').replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}

function getMessageUser() {
  return process.env.SRS_MESSAGE_USER || process.env.SRS_USER || process.env.SRS_USERNAME || '';
}

function getMessagePassword() {
  return process.env.SRS_MESSAGE_PASSWORD || process.env.SRS_PASSWORD || '';
}

function getTagText(xml, tagName) {
  const patterns = [
    new RegExp(`<[^<:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^<:>]*:?${tagName}>`, 'i'),
    new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'i')
  ];

  for (const pattern of patterns) {
    const match = String(xml || '').match(pattern);
    if (match) return stripCdata(match[1]).trim();
  }

  return '';
}

function getBlocks(xml, tagName) {
  const pattern = new RegExp(`<[^<:>]*:?${tagName}[^>]*>([\\s\\S]*?)<\\/[^<:>]*:?${tagName}>`, 'gi');
  const blocks = [];
  let match;

  while ((match = pattern.exec(String(xml || '')))) {
    blocks.push(match[1]);
  }

  return blocks;
}

function unique(values) {
  return Array.from(new Set(values.map(String).filter(Boolean)));
}

export function getStoresByBranchIds(branchIds = []) {
  const branchMap = getSrsBranchMap();
  const wanted = new Set((branchIds || []).map(String));

  return Object.entries(branchMap)
    .filter(([store, branchId]) => store && branchId && wanted.has(String(branchId)))
    .map(([store]) => store);
}

export function getAllConfiguredStores() {
  const branchMap = getSrsBranchMap();

  return Object.entries(branchMap)
    .filter(([store, branchId]) => store && branchId)
    .map(([store]) => store);
}

function parsePerson(block) {
  const branches = unique(getBlocks(block, 'BranchId').map((branchBlock) => branchBlock.replace(/<[^>]+>/g, '').trim()));
  const personnelId = getTagText(block, 'PersonnelId');
  const internalName = getTagText(block, 'InternalName');
  const externalName = getTagText(block, 'ExternalName');
  const activeRaw = getTagText(block, 'Active');
  const active = String(activeRaw).toLowerCase() === 'true' || activeRaw === '1';
  const posLoginCode = getTagText(block, 'PosLoginCode');

  return {
    personnelId,
    internalName,
    externalName,
    name: externalName || internalName || `Medewerker ${personnelId}`,
    personnelGroupId: getTagText(block, 'PersonnelGroupId'),
    posLoginCode,
    fingerprintRequiredToLogin: String(getTagText(block, 'FingerprintRequiredToLogin')).toLowerCase() === 'true',
    active,
    branches,
    stores: getStoresByBranchIds(branches)
  };
}

function parsePersonnelResponse(xml) {
  const fault = getTagText(xml, 'faultstring') || getTagText(xml, 'FaultString');

  if (fault) {
    const error = new Error(fault);
    error.fault = fault;
    throw error;
  }

  const personBlocks = getBlocks(xml, 'Person');

  return personBlocks.map(parsePerson).filter((person) => person.personnelId);
}

export async function getPersonnel({ personnelId = '', from = '', to = '' } = {}) {
  const user = getMessageUser();
  const password = getMessagePassword();

  if (!user || !password) {
    throw new Error('SRS_MESSAGE_USER of SRS_MESSAGE_PASSWORD ontbreekt in Vercel.');
  }

  const rangeFrom = String(from || process.env.SRS_PERSONNEL_ID_FROM || '1').trim();
  const rangeTo = String(to || process.env.SRS_PERSONNEL_ID_TO || '999').trim();
  const specificPersonnelId = String(personnelId || '').trim();

  const bodyFilter = specificPersonnelId
    ? `<data:PersonnelId>${xmlEscape(specificPersonnelId)}</data:PersonnelId>`
    : `<data:PersonnelIdFrom>${xmlEscape(rangeFrom)}</data:PersonnelIdFrom><data:PersonnelIdTo>${xmlEscape(rangeTo)}</data:PersonnelIdTo>`;

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Personnel/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetPersonnel>
      <data:Login>
        <com:Id>${xmlEscape(user)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </data:Login>
      <data:Body>${bodyFilter}</data:Body>
    </data:GetPersonnel>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await fetch(PERSONNEL_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: 'GetPersonnel'
    },
    body: envelope
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`SRS Personnel fout ${response.status}: ${text.slice(0, 500)}`);
  }

  return parsePersonnelResponse(text);
}

export async function findPersonnelForLogin({ personnelId, posLoginCode }) {
  const cleanPersonnelId = String(personnelId || '').trim();
  const cleanCode = String(posLoginCode || '').trim();

  if (!cleanPersonnelId || !cleanCode) {
    throw new Error('Vul personeelsnummer en kassacode in.');
  }

  const persons = await getPersonnel({ personnelId: cleanPersonnelId });
  const person = persons.find((item) => String(item.personnelId) === cleanPersonnelId);

  if (!person) {
    throw new Error('Personeelsnummer niet gevonden in SRS.');
  }

  if (!person.active) {
    throw new Error('Deze medewerker staat niet actief in SRS.');
  }

  if (String(person.posLoginCode || '') !== cleanCode) {
    throw new Error('Kassacode is onjuist.');
  }

  if (!person.branches.length && !person.stores.length) {
    throw new Error('Deze medewerker heeft geen gekoppelde filialen in SRS.');
  }

  return person;
}
