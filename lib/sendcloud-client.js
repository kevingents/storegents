const SENDCLOUD_API_BASE = 'https://panel.sendcloud.sc/api/v2';

/*
  Alleen uitzonderingen hier. Nieuwe winkels hoeven normaal niet in code.
  Voorwaarde: winkelnaam in Shopify en Sendcloud bevat dezelfde plaatsnaam.
  Voorbeeld Sendcloud: GENTS (Haarlem), Straat 1, Haarlem
*/
const STORE_EXCEPTION_ALIASES = {
  'GENTS Den Bosch': ['den bosch', 's hertogenbosch', 'hertogenbosch'],
  'GENTS Amsterdam': ['amsterdam', 'van woustraat'],
  'GENTS Leiden': ['leiden', 'haarlemmerstraat'],
  'GENTS Tilburg': ['tilburg', 'emmapassage'],
  'GENTS Utrecht': ['utrecht', 'steenweg'],
  'GENTS Zwolle': ['zwolle', 'lutteke']
};

function getSendcloudCredentials() {
  const publicKey =
    process.env.SENDCLOUD_PUBLIC_KEY ||
    process.env.sendcloud_public ||
    process.env.SENDCLOUD_API_KEY ||
    '';

  const secretKey =
    process.env.SENDCLOUD_SECRET_KEY ||
    process.env.sendcloud_secret ||
    process.env.SENDCLOUD_API_SECRET ||
    '';

  if (!publicKey || !secretKey) {
    throw new Error('Sendcloud keys ontbreken. Zet SENDCLOUD_PUBLIC_KEY en SENDCLOUD_SECRET_KEY in Vercel.');
  }

  return { publicKey, secretKey };
}

function getAuthHeader() {
  const { publicKey, secretKey } = getSendcloudCredentials();
  return 'Basic ' + Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
}

export async function sendcloudRequest(path, options = {}) {
  const response = await fetch(`${SENDCLOUD_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: getAuthHeader(),
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await response.text();

  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (error) {
    data = { raw: text };
  }

  if (!response.ok) {
    const message =
      data?.error?.message ||
      data?.message ||
      data?.detail ||
      data?.raw ||
      `Sendcloud fout: ${response.status}`;

    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

export async function getSenderAddresses() {
  const data = await sendcloudRequest('/user/addresses/sender');
  return data.sender_addresses || data.addresses || [];
}

export async function getShippingMethods(params = {}) {
  const search = new URLSearchParams();

  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      search.set(key, value);
    }
  });

  const query = search.toString();
  const data = await sendcloudRequest(`/shipping_methods${query ? `?${query}` : ''}`);
  return data.shipping_methods || [];
}

export function normalizeStoreName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/^gents\s*/i, '')
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[()]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getAddressSearchText(address) {
  return normalizeText([
    address.id,
    address.company_name,
    address.name,
    address.contact_name,
    address.address,
    address.street,
    address.house_number,
    address.city,
    address.postal_code,
    address.postcode
  ].join(' '));
}

function getStoreAliases(storeName) {
  const directAliases = STORE_EXCEPTION_ALIASES[storeName] || [];
  const normalized = normalizeStoreName(storeName);
  const aliases = [...directAliases];

  if (normalized) {
    aliases.push(normalized);

    const parts = normalized.split(' ').filter(Boolean);
    parts.forEach((part) => {
      if (part.length >= 3) {
        aliases.push(part);
      }
    });
  }

  return [...new Set(aliases.map(normalizeText).filter(Boolean))];
}

export async function findSenderAddressForStore(storeName) {
  const addresses = await getSenderAddresses();
  const aliases = getStoreAliases(storeName);

  if (!aliases.length) {
    throw new Error('Winkel ontbreekt voor Sendcloud afzenderadres.');
  }

  const found = addresses.find((address) => {
    const text = getAddressSearchText(address);

    return aliases.some((alias) => {
      return alias && text.includes(alias);
    });
  });

  if (!found) {
    const available = addresses
      .map((address) => {
        return [
          address.id,
          address.company_name,
          address.name,
          address.contact_name,
          address.address,
          address.city
        ].filter(Boolean).join(' - ');
      })
      .join(' | ');

    throw new Error(
      `Geen Sendcloud afzenderadres gevonden voor ${storeName}. Controleer dat Sendcloud een sender address heeft met deze plaatsnaam. Beschikbare adressen: ${available}`
    );
  }

  return found;
}

export async function findDhlDropoffMethod(senderAddressId) {
  if (process.env.SENDCLOUD_SHIPPING_METHOD_ID) {
    return {
      id: Number(process.env.SENDCLOUD_SHIPPING_METHOD_ID),
      name: process.env.SENDCLOUD_SHIPPING_METHOD_NAME || 'DHL For You Dropoff - S'
    };
  }

  const methods = await getShippingMethods({
    sender_address: senderAddressId,
    to_country: 'NL'
  });

  const preferredName = String(process.env.SENDCLOUD_SHIPPING_METHOD_NAME || 'DHL For You Dropoff - S').toLowerCase();

  const exact = methods.find((method) => String(method.name || '').toLowerCase() === preferredName);
  if (exact) return exact;

  const fuzzy = methods.find((method) => {
    const name = String(method.name || '').toLowerCase();
    return name.includes('dhl') && name.includes('drop') && (name.includes('s') || name.includes('small'));
  });

  if (fuzzy) return fuzzy;

  throw new Error('DHL For You Dropoff - S kon niet automatisch gevonden worden. Zet SENDCLOUD_SHIPPING_METHOD_ID in Vercel.');
}

export function senderAddressToRecipient(address, fallbackName = 'GENTS') {
  const street =
    address.street ||
    address.address_divided?.street ||
    address.address ||
    '';

  const houseNumber =
    address.house_number ||
    address.address_divided?.house_number ||
    address.number ||
    '';

  return {
    name: fallbackName,
    company_name: fallbackName,
    address: street,
    house_number: houseNumber,
    postal_code: address.postal_code || address.postcode || '',
    city: address.city || '',
    country: address.country || address.country_iso_2 || 'NL',
    telephone: address.telephone || address.phone || '0612345678',
    email: address.email || 'administratie@gents.nl'
  };
}
