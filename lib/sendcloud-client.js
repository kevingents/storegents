const SENDCLOUD_API_BASE = 'https://panel.sendcloud.sc/api/v2';

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
    .trim();
}

function getAddressSearchText(address) {
  return [
    address.id,
    address.company_name,
    address.name,
    address.contact_name,
    address.address,
    address.street,
    address.city,
    address.postal_code,
    address.postcode
  ].join(' ').toLowerCase();
}

export async function findSenderAddressForStore(storeName) {
  const addresses = await getSenderAddresses();
  const wanted = normalizeStoreName(storeName);

  if (!wanted) {
    throw new Error('Winkel ontbreekt voor Sendcloud afzenderadres.');
  }

  let found = addresses.find((address) => {
    const text = getAddressSearchText(address);
    return text.includes(wanted);
  });

  if (!found) {
    found = addresses.find((address) => address.is_default || address.default);
  }

  if (!found) {
    throw new Error(`Geen Sendcloud afzenderadres gevonden voor ${storeName}.`);
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
    name: address.contact_name || address.name || fallbackName,
    company_name: address.company_name || fallbackName,
    address: street,
    house_number: houseNumber,
    postal_code: address.postal_code || address.postcode || '',
    city: address.city || '',
    country: address.country || address.country_iso_2 || 'NL',
    telephone: address.telephone || address.phone || '',
    email: address.email || ''
  };
}
