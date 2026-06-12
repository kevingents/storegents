import crypto from 'crypto';

const DEFAULT_SRS_MESSAGE_BASE_URL = 'https://ws.storeinfo.nl';
const CUSTOMERS_MESSAGE_PATH = '/messages/v1/soap/Customers.php';

const SRS_CUSTOMERS_TIMEOUT_MS = Number(
  process.env.SRS_CUSTOMERS_TIMEOUT_MS ||
  process.env.SRS_SOAP_TIMEOUT_MS ||
  45000
);

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
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getConfig() {
  const id = process.env.SRS_MESSAGE_USER || process.env.srs_message_user || '';
  const password = process.env.SRS_MESSAGE_PASSWORD || process.env.srs_message_password || '';
  const baseUrl = (process.env.SRS_BASE_URL || DEFAULT_SRS_MESSAGE_BASE_URL).replace(/\/$/, '');

  if (!id || !password) {
    throw new Error('SRS_MESSAGE_USER en/of SRS_MESSAGE_PASSWORD ontbreken.');
  }

  return {
    id,
    password,
    endpoint: `${baseUrl}${CUSTOMERS_MESSAGE_PATH}`
  };
}

function getLoginXml(prefix = 'data') {
  const { id, password } = getConfig();

  return `
    <${prefix}:Login>
      <com:Id>${xmlEscape(id)}</com:Id>
      <com:Password>${xmlEscape(password)}</com:Password>
    </${prefix}:Login>
  `;
}

function getTransactionHeaderXml(prefix = 'tran') {
  const { id, password } = getConfig();

  return `
    <${prefix}:Header>
      <com:Login>
        <com:Id>${xmlEscape(id)}</com:Id>
        <com:Password>${xmlEscape(password)}</com:Password>
      </com:Login>
      <com:TransactionId>${crypto.randomUUID()}</com:TransactionId>
      <com:Timestamp>${new Date().toISOString().slice(0, 19)}</com:Timestamp>
    </${prefix}:Header>
  `;
}

function getNodeText(xml, tagName) {
  const regex = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`,
    'i'
  );

  const match = String(xml || '').match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

/* Leaf-variant: alleen tekst zónder kind-tags. SRS-transaction-responses hebben
   een BUITENSTE <…:Status> om de Header met dáárin de echte <com:Status>completed
   </…>; de gewone getNodeText pakt dan de hele XML-blob i.p.v. "completed",
   waardoor `success === 'completed'` (bv. in updateCustomer) altijd false werd. */
function getLeafNodeText(xml, tagName) {
  const regex = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>\\s*([^<>]+?)\\s*<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`,
    'i'
  );
  const match = String(xml || '').match(regex);
  return match ? decodeXml(match[1].trim()) : '';
}

function getAllBlocks(xml, tagName) {
  const regex = new RegExp(
    `<(?:[A-Za-z0-9_]+:)?${tagName}[^>]*>([\\s\\S]*?)<\\/(?:[A-Za-z0-9_]+:)?${tagName}>`,
    'gi'
  );

  return Array.from(String(xml || '').matchAll(regex)).map((match) => match[1]);
}

function textFromFirst(block, tags) {
  for (const tag of tags) {
    const value = getNodeText(block, tag);
    if (value) return value;
  }

  return '';
}

function parseSoapFault(xml) {
  const faultString =
    getNodeText(xml, 'faultstring') ||
    getNodeText(xml, 'Reason') ||
    getNodeText(xml, 'Text');

  const faultCode =
    getNodeText(xml, 'faultcode') ||
    getNodeText(xml, 'Code');

  return faultString ? { code: faultCode, message: faultString } : null;
}

async function postSoap(action, xml) {
  const { endpoint } = getConfig();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SRS_CUSTOMERS_TIMEOUT_MS);

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
      const error = new Error(fault?.message || `SRS Customers fout: ${response.status}`);
      error.status = response.status;
      error.responseText = text;
      throw error;
    }

    return text;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`SRS Customers timeout na ${SRS_CUSTOMERS_TIMEOUT_MS}ms (${action}).`);
      timeoutError.status = 504;
      throw timeoutError;
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function cleanEmail(value) {
  const text = decodeXml(String(value || '').trim());
  const match = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].trim() : '';
}

function extractCustomerEmail(block) {
  const xml = String(block || '');

  /*
    SRS geeft e-mail genest terug:
    <EmailAddress>
      <Type>Privé</Type>
      <EmailAddress>naam@mail.nl</EmailAddress>
    </EmailAddress>

    Een simpele getNodeText('EmailAddress') kan dan per ongeluk het hele
    buitenste XML-blok pakken. Daarom zoeken we expliciet naar tekst met @.
  */
  const directMatches = Array.from(
    xml.matchAll(
      /<(?:[A-Za-z0-9_]+:)?EmailAddress\b[^>]*>([^<>]*@[^<>]*)<\/(?:[A-Za-z0-9_]+:)?EmailAddress>/gi
    )
  )
    .map((match) => cleanEmail(match[1]))
    .filter(Boolean);

  if (directMatches.length) return directMatches[0];

  return cleanEmail(xml);
}

function extractCustomerPhone(block) {
  const xml = String(block || '');
  const phoneBlock = getAllBlocks(xml, 'PhoneNumber')[0] || '';
  const number = getNodeText(phoneBlock, 'Number') || getNodeText(xml, 'Number');

  return String(number || '').trim();
}

function extractCustomerAddress(block) {
  const xml = String(block || '');
  const addressBlocks = getAllBlocks(xml, 'Address');
  const addressBlock = addressBlocks[0] || getNodeText(xml, 'Address') || xml;

  return {
    address1: getNodeText(addressBlock, 'Address1'),
    houseNumber: getNodeText(addressBlock, 'HouseNumber'),
    houseNumberSuffix: getNodeText(addressBlock, 'HouseNumberSuffix'),
    city: getNodeText(addressBlock, 'City'),
    country: getNodeText(addressBlock, 'Country'),
    postalCode: getNodeText(addressBlock, 'PostalCode')
  };
}

function extractLoyaltyCardId(block) {
  const xml = String(block || '');

  const direct =
    getNodeText(xml, 'LoyaltyCardId') ||
    getNodeText(xml, 'CardId');

  return String(direct || '').trim();
}

/*
  SRS klant-kenmerken ("Labels"). In de SRS-UI staan deze als genummerde labels
  op de klant (kolom LABEL NR. + OMSCHRIJVING):
     1 = Korting, 2 = Vereniging, 3 = Bedrijf, 4 = Type Vereniging, 5 = open vraag.
  SRS levert ze NIET als losse tags (<Vereniging>…), maar als <Label>-blokken.
  Daarom parsen we permissief: nummer + omschrijving + waarde via meerdere
  mogelijke tag-/attribuutnamen, en mappen we op NUMMER (hard) met OMSCHRIJVING
  als fallback. Zo blijft het werken ook als SRS net iets andere tagnamen geeft.
*/
const LABEL_NR = { vereniging: 2, verenigingType: 4, korting: 1, bedrijf: 3 };

function stripInnerTags(value) {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function attrFrom(openTag, names) {
  for (const n of names) {
    const m = String(openTag || '').match(new RegExp(`${n}\\s*=\\s*"([^"]*)"`, 'i'));
    if (m) return decodeXml(m[1].trim());
  }
  return '';
}

/** Haal alle kenmerk-blokken uit een Customer-XML als {nr, omschrijving, waarde}. */
function extractLabels(block) {
  const xml = String(block || '');
  const out = [];
  const re = /<(?:[A-Za-z0-9_]+:)?(Label|CustomField|UserField|Kenmerk|ExtraField)\b([^>]*)>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?\1>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const openAttrs = m[2] || '';
    const inner = m[3] || '';
    const nrRaw = attrFrom(openAttrs, ['Number', 'Nr', 'LabelNr', 'LabelNumber', 'Id', 'Code'])
      || textFromFirst(inner, ['Number', 'Nr', 'LabelNr', 'LabelNumber', 'Id', 'Code']);
    const oms = attrFrom(openAttrs, ['Description', 'Omschrijving', 'Name'])
      || textFromFirst(inner, ['Description', 'Omschrijving', 'Name']);
    let waarde = textFromFirst(inner, ['Value', 'Waarde', 'SelectionValue', 'Selection', 'Text', 'Content', 'Answer', 'Antwoord', 'Option']);
    if (!waarde) {
      /* Geen herkenbare waarde-tag → neem de kale tekst minus de meta-tags. */
      const bare = inner.replace(/<(?:[A-Za-z0-9_]+:)?(Number|Nr|LabelNr|LabelNumber|Id|Code|Description|Omschrijving|Name|Soort|Type|Required|Verplicht|Vervallen)\b[^>]*>[\s\S]*?<\/(?:[A-Za-z0-9_]+:)?\1>/gi, '');
      waarde = stripInnerTags(bare);
    }
    const nr = Number(String(nrRaw).replace(/[^0-9]/g, ''));
    out.push({ nr: Number.isFinite(nr) && nr ? nr : null, omschrijving: String(oms || '').trim(), waarde: String(waarde || '').trim() });
  }
  return out;
}

/** Waarde van een kenmerk: eerst op nummer, dan op omschrijving-patroon. */
function labelValue(labels, nr, omsRe) {
  for (const l of labels) { if (nr && l.nr === nr && l.waarde) return l.waarde; }
  if (omsRe) { for (const l of labels) { if (omsRe.test(l.omschrijving || '') && l.waarde) return l.waarde; } }
  return '';
}

function parseCustomer(block) {
  const nameBlock = getNodeText(block, 'Name') || block;
  const address = extractCustomerAddress(block);

  const firstName = getNodeText(nameBlock, 'FirstName');
  const lastName = getNodeText(nameBlock, 'LastName');
  const title = getNodeText(nameBlock, 'Title');

  const receiptCountRaw = textFromFirst(block, [
    'ReceiptCount',
    'ReceiptsCount',
    'NumberOfReceipts',
    'TotalReceipts'
  ]);

  const email = extractCustomerEmail(block);
  const phone = extractCustomerPhone(block);

  /* Kenmerken (labels) — bron-van-waarheid voor vereniging/type/korting/bedrijf.
     Eerst op labelnummer (2/4/1/3), met omschrijving als fallback; daarna pas de
     oude losse-tag-gokken (voor SRS-tenants die het wél als tag teruggeven). */
  const labels = extractLabels(block);
  const vereniging = labelValue(labels, LABEL_NR.vereniging, /^vereniging$/i) || textFromFirst(block, [
    'Vereniging', 'VerenigingName', 'VerenigingNaam', 'AssociationName', 'Association',
    'Studentvereniging', 'Studentenvereniging', 'StudentenVereniging', 'StudentAssociation'
  ]);

  return {
    customerId: textFromFirst(block, ['CustomerId', 'CustomerID']),
    loyaltyCardId: extractLoyaltyCardId(block),
    createdAt: textFromFirst(block, ['CreatedAt', 'Created']),
    updatedAt: textFromFirst(block, ['UpdatedAt', 'Updated']),
    active: getNodeText(block, 'Active'),

    title,
    firstName,
    lastName,
    name:
      [title, firstName, lastName].filter(Boolean).join(' ').trim() ||
      title ||
      '',

    gender: getNodeText(block, 'Gender'),
    birthDate: getNodeText(block, 'BirthDate'),

    /*
      Belangrijk:
      RegisteredInBranchId mag volgens SRS NIET als GetCustomers-filter worden meegestuurd.
      Het komt wel terug in de response. Rapportages moeten dus op Created ophalen
      en daarna lokaal op registeredInBranchId groeperen.
    */
    registeredInBranchId: getNodeText(block, 'RegisteredInBranchId'),

    allowMailings: getNodeText(block, 'AllowMailings'),
    receivesLoyaltyPoints: getNodeText(block, 'ReceivesLoyaltyPoints'),

    email,
    phone,

    address1: address.address1,
    houseNumber: address.houseNumber,
    houseNumberSuffix: address.houseNumberSuffix,
    city: address.city,
    country: address.country,
    postalCode: address.postalCode,

    receiptCount: Number.parseInt(String(receiptCountRaw || '0'), 10) || 0,

    /* Vereniging — gevuld via lokale const hierboven (bv. 'Minerva Leiden', 'EBF') */
    vereniging,
    /* Backwards-compat alias zodat oude UI-code blijft werken */
    studentvereniging: vereniging,

    /* Type vereniging — bv. 'Studentenvereniging' / 'Sportvereniging' (label 4) */
    verenigingType: labelValue(labels, LABEL_NR.verenigingType, /type\s*vereniging/i) || textFromFirst(block, [
      'VerenigingType', 'TypeVereniging', 'VerenigingsType', 'Verenigingstype',
      'AssociationType', 'TypeAssociation'
    ]),

    /* Korting — kortingsstaffel/percentage uit kenmerk (label 1) */
    korting: labelValue(labels, LABEL_NR.korting, /korting/i),

    /* Bedrijf — als klant via bedrijfsaccount koopt (kledingbon etc.) (label 3) */
    bedrijf: labelValue(labels, LABEL_NR.bedrijf, /bedrijf|company/i) || textFromFirst(block, [
      'Bedrijf', 'Company', 'CompanyName', 'BedrijfsNaam', 'Bedrijfsnaam',
      'Organisation', 'Organization'
    ]),

    /* Ruwe kenmerken (debug/inzicht): [{nr, omschrijving, waarde}] */
    labels,

    /* Notitie uit SRS (los van onze admin-notes blob) */
    srsNotitie: textFromFirst(block, [
      'Notitie', 'Note', 'Notes', 'Remarks', 'Opmerking', 'Opmerkingen'
    ])
  };
}

function parseCustomers(xml) {
  return getAllBlocks(xml, 'Customer')
    .map(parseCustomer)
    .filter((customer) => customer.customerId || customer.email || customer.name);
}

/**
 * Debug helper: extract ALL unique XML element names + their first value uit
 * een Customer-blok. Handig om te ontdekken welke custom velden SRS terug
 * geeft (zoals studentvereniging) zonder dat we tag-namen vooraf kennen.
 *
 * Niet automatisch gebruikt — alleen door endpoints met ?debug=1 flag.
 */
export function debugExtractCustomerFields(xml) {
  const blocks = getAllBlocks(xml, 'Customer');
  if (!blocks.length) return [];
  return blocks.slice(0, 3).map((block) => {
    const fields = {};
    /* Match alle direct child-tags + hun (eerste) text-inhoud */
    const tagPattern = /<(?:\w+:)?(\w+)(?:\s[^>]*)?>([^<]+)<\/(?:\w+:)?\w+>/g;
    let match;
    while ((match = tagPattern.exec(block)) !== null) {
      const tag = match[1];
      const value = match[2].trim();
      if (!fields[tag] && value && tag !== 'Customer') fields[tag] = value;
    }
    return fields;
  });
}

function bodyFiltersXml(filters = {}) {
  const parts = [];

  if (filters.customerId) {
    parts.push(`<data:CustomerId>${xmlEscape(filters.customerId)}</data:CustomerId>`);
  }

  if (filters.loyaltyCardId) {
    parts.push(`<data:LoyaltyCardId>${xmlEscape(filters.loyaltyCardId)}</data:LoyaltyCardId>`);
  }

  if (filters.name) {
    parts.push(`<data:Name>${xmlEscape(filters.name)}</data:Name>`);
  }

  if (filters.email) {
    parts.push(`<data:EmailAddress>${xmlEscape(filters.email)}</data:EmailAddress>`);
  }

  if (filters.phone) {
    parts.push(`<data:PhoneNumber>${xmlEscape(filters.phone)}</data:PhoneNumber>`);
  }

  if (filters.postalCode || filters.houseNumber) {
    parts.push(`
      <data:Address>
        ${filters.houseNumber ? `<com:HouseNumber>${xmlEscape(filters.houseNumber)}</com:HouseNumber>` : ''}
        ${filters.postalCode ? `<com:PostalCode>${xmlEscape(filters.postalCode)}</com:PostalCode>` : ''}
      </data:Address>
    `);
  }

  /*
    NIET toevoegen:
    <data:RegisteredInBranchId>...</data:RegisteredInBranchId>

    SRS GetCustomers accepteert dit niet als filter.
    De branchId staat alleen in Create/Update en in de response.
  */

  if (filters.createdFrom || filters.createdUntil) {
    parts.push(`
      <data:Created>
        ${filters.createdFrom ? `<com:From>${xmlEscape(filters.createdFrom)}</com:From>` : ''}
        ${filters.createdUntil ? `<com:Until>${xmlEscape(filters.createdUntil)}</com:Until>` : ''}
      </data:Created>
    `);
  }

  if (filters.updatedFrom || filters.updatedUntil) {
    parts.push(`
      <data:Updated>
        ${filters.updatedFrom ? `<com:From>${xmlEscape(filters.updatedFrom)}</com:From>` : ''}
        ${filters.updatedUntil ? `<com:Until>${xmlEscape(filters.updatedUntil)}</com:Until>` : ''}
      </data:Updated>
    `);
  }

  /* SRS pagination gebruikt Skip (offset) + Take (page size), NIET Page/PageSize.
     De XSD verwacht na <com:Skip> exact <com:Take> — <com:PageSize> faalt op
     XSD-validatie ("Element PageSize: not expected. Expected is Take").
     Als 'page' wordt meegegeven converteren we naar skip = (page-1) * pageSize. */
  if (filters.skip !== undefined || filters.page || filters.pageSize) {
    const pageSize = Number(filters.pageSize || 500);
    const skip = filters.skip !== undefined
      ? Number(filters.skip || 0)
      : Math.max(0, (Number(filters.page || 1) - 1) * pageSize);
    parts.push(`
      <data:Pagination>
        <com:Skip>${xmlEscape(String(skip))}</com:Skip>
        <com:Take>${xmlEscape(String(pageSize))}</com:Take>
      </data:Pagination>
    `);
  }

  return parts.join('\n');
}

export async function getCustomers(filters = {}) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Customers/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetCustomers>
      ${getLoginXml('data')}
      <data:Body>
        ${bodyFiltersXml(filters)}
      </data:Body>
    </data:GetCustomers>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('GetCustomers', xml);

  return {
    customers: parseCustomers(raw),
    raw
  };
}

function parseTransactions(xml) {
  return getAllBlocks(xml, 'Transaction').map((block) => {
    const items = getAllBlocks(block, 'Item').map((item) => ({
      lineNr: getNodeText(item, 'LineNr'),
      sku: getNodeText(item, 'Sku'),
      description: textFromFirst(item, ['Omschrijving', 'Beschrijving', 'Description', 'ItemDescription', 'Desc']),
      pieces: Number(getNodeText(item, 'Pieces') || 0),
      charged: Number(getNodeText(item, 'Charged') || 0),
      vat: Number(getNodeText(item, 'VAT') || 0),
      listPrice: Number(getNodeText(item, 'ListPrice') || 0),
      costPrice: Number(getNodeText(item, 'CostPrice') || 0)
    }));

    return {
      branchId: getNodeText(block, 'BranchId'),
      posNr: getNodeText(block, 'PosNr'),
      personnelId: getNodeText(block, 'PersonnelId'),
      dateTime: getNodeText(block, 'DateTime'),
      receiptNr: getNodeText(block, 'ReceiptNr') || getNodeText(block, 'ReceiptNo'),
      orderNr: getNodeText(block, 'OrderNr') || getNodeText(block, 'OrderNo'),
      customerId: getNodeText(block, 'CustomerId'),
      total: items.reduce((sum, item) => sum + Number(item.charged || 0), 0),
      items
    };
  });
}

export async function getTransactions({
  customerId,
  from,
  until
} = {}) {
  const hasCustomerId = String(customerId || '').trim();
  const hasPeriod = from || until;

  if (!hasCustomerId && !hasPeriod) {
    return {
      transactions: [],
      raw: ''
    };
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Customers/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetTransactions>
      ${getLoginXml('data')}
      <data:Body>
        ${hasCustomerId ? `<data:CustomerId>${xmlEscape(hasCustomerId)}</data:CustomerId>` : ''}
        ${
          hasPeriod
            ? `
              <data:PeriodWithTime>
                ${from ? `<data:From>${xmlEscape(from)}</data:From>` : ''}
                ${until ? `<data:Until>${xmlEscape(until)}</data:Until>` : ''}
              </data:PeriodWithTime>
            `
            : ''
        }
      </data:Body>
    </data:GetTransactions>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('GetTransactions', xml);

  return {
    transactions: parseTransactions(raw),
    raw
  };
}

function parseBills(xml) {
  return getAllBlocks(xml, 'Bill').map((block) => ({
    billNr: getNodeText(block, 'BillNr'),
    customerId: getNodeText(block, 'CustomerId'),
    amount: Number(getNodeText(block, 'Amount') || 0),
    amountPaid: Number(getNodeText(block, 'AmountPaid') || 0),
    paid: getNodeText(block, 'Paid'),
    branchId: getNodeText(block, 'BranchId'),
    posNr: getNodeText(block, 'PosNr'),
    personnelId: getNodeText(block, 'PersonnelId'),
    dateTime: getNodeText(block, 'DateTime'),
    receiptNr: getNodeText(block, 'ReceiptNr')
  }));
}

export async function getBills({
  customerId,
  includePaid = true
} = {}) {
  if (!customerId) {
    return {
      bills: [],
      raw: ''
    };
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:data="https://messages.storeinfo.nl/v1/Customers/Data" xmlns:com="https://messages.storeinfo.nl/v1/Common">
  <soapenv:Header/>
  <soapenv:Body>
    <data:GetBills>
      ${getLoginXml('data')}
      <data:Body>
        <data:CustomerId>${xmlEscape(customerId)}</data:CustomerId>
        <data:IncludePaid>${includePaid ? 'true' : 'false'}</data:IncludePaid>
      </data:Body>
    </data:GetBills>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('GetBills', xml);

  return {
    bills: parseBills(raw),
    raw
  };
}

export async function createCustomer(customer = {}) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Customers/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:cus="https://messages.storeinfo.nl/v1/Customers">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Create>
      ${getTransactionHeaderXml('tran')}
      <tran:Body>
        <tran:Customers>
          <tran:Customer>
            <cus:Name>
              ${customer.title ? `<cus:Title>${xmlEscape(customer.title)}</cus:Title>` : ''}
              ${customer.firstName ? `<cus:FirstName>${xmlEscape(customer.firstName)}</cus:FirstName>` : ''}
              ${customer.lastName ? `<cus:LastName>${xmlEscape(customer.lastName)}</cus:LastName>` : ''}
            </cus:Name>
            ${customer.gender ? `<cus:Gender>${xmlEscape(customer.gender)}</cus:Gender>` : ''}
            ${customer.birthDate ? `<cus:BirthDate>${xmlEscape(customer.birthDate)}</cus:BirthDate>` : ''}
            ${
              customer.registeredInBranchId
                ? `<cus:RegisteredInBranchId>${xmlEscape(customer.registeredInBranchId)}</cus:RegisteredInBranchId>`
                : ''
            }
            <cus:AllowMailings>${customer.allowMailings ? 'true' : 'false'}</cus:AllowMailings>
            <cus:ReceivesLoyaltyPoints>${customer.receivesLoyaltyPoints !== false ? 'true' : 'false'}</cus:ReceivesLoyaltyPoints>
            ${
              customer.email
                ? `
                  <cus:EmailAddresses>
                    <cus:EmailAddress>
                      <cus:Type>0</cus:Type>
                      <cus:EmailAddress>${xmlEscape(customer.email)}</cus:EmailAddress>
                    </cus:EmailAddress>
                  </cus:EmailAddresses>
                `
                : ''
            }
          </tran:Customer>
        </tran:Customers>
      </tran:Body>
    </tran:Create>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('Create', xml);

  return {
    customers: parseCustomers(raw),
    status: getLeafNodeText(raw, 'Status') || getNodeText(raw, 'Status'),
    raw
  };
}

/**
 * Partial update van een SRS klant. CustomerId is verplicht; alleen meegegeven
 * velden worden naar SRS gestuurd. Op dit moment ondersteund: email toevoegen.
 */
export async function updateCustomer(customer = {}) {
  const customerId = String(customer.customerId || '').trim();
  if (!customerId) {
    throw new Error('updateCustomer: customerId is verplicht');
  }

  const emailBlock = customer.email
    ? `
        <cus:EmailAddresses>
          <cus:EmailAddress>
            <cus:Type>0</cus:Type>
            <cus:EmailAddress>${xmlEscape(customer.email)}</cus:EmailAddress>
          </cus:EmailAddress>
        </cus:EmailAddresses>
      `
    : '';

  const allowMailingsBlock = typeof customer.allowMailings === 'boolean'
    ? `<cus:AllowMailings>${customer.allowMailings ? 'true' : 'false'}</cus:AllowMailings>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:tran="https://messages.storeinfo.nl/v1/Customers/Transactions" xmlns:com="https://messages.storeinfo.nl/v1/Common" xmlns:cus="https://messages.storeinfo.nl/v1/Customers">
  <soapenv:Header/>
  <soapenv:Body>
    <tran:Update>
      ${getTransactionHeaderXml('tran')}
      <tran:Body>
        <tran:Customers>
          <tran:Customer>
            <cus:CustomerId>${xmlEscape(customerId)}</cus:CustomerId>
            ${allowMailingsBlock}
            ${emailBlock}
          </tran:Customer>
        </tran:Customers>
      </tran:Body>
    </tran:Update>
  </soapenv:Body>
</soapenv:Envelope>`;

  const raw = await postSoap('Update', xml);
  const status = getLeafNodeText(raw, 'Status') || getNodeText(raw, 'Status') || '';

  return {
    success: String(status).toLowerCase() === 'completed',
    status,
    raw
  };
}
