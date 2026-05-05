import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getSenderAddresses, findSenderAddressForStore, findDhlDropoffMethod } from '../../lib/sendcloud-client.js';

function mask(value) {
  const raw = String(value || '');
  if (!raw) return '';
  if (raw.length <= 8) return '********';
  return `${raw.slice(0, 4)}...${raw.slice(-4)}`;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const store = String(req.query.store || 'GENTS Utrecht').trim();
  const publicKey = process.env.SENDCLOUD_PUBLIC_KEY || process.env.sendcloud_public || process.env.SENDCLOUD_API_KEY || '';
  const secretKey = process.env.SENDCLOUD_SECRET_KEY || process.env.sendcloud_secret || process.env.SENDCLOUD_API_SECRET || '';

  const result = {
    success: true,
    store,
    env: {
      publicKeyPresent: Boolean(publicKey),
      publicKeyMasked: mask(publicKey),
      secretKeyPresent: Boolean(secretKey),
      shippingMethodId: process.env.SENDCLOUD_SHIPPING_METHOD_ID || '',
      shippingMethodName: process.env.SENDCLOUD_SHIPPING_METHOD_NAME || '',
      fixedCost: process.env.SENDCLOUD_LABEL_FIXED_COST || ''
    },
    checks: []
  };

  try {
    const addresses = await getSenderAddresses();
    result.senderAddresses = addresses.map((address) => ({
      id: address.id,
      company_name: address.company_name || '',
      name: address.name || '',
      contact_name: address.contact_name || '',
      address: address.address || address.street || '',
      house_number: address.house_number || address.address_divided?.house_number || '',
      postal_code: address.postal_code || address.postcode || '',
      city: address.city || ''
    }));
    result.checks.push({ key: 'sender_addresses', status: 'ok', message: `${addresses.length} afzenderadres(sen) gevonden.` });
  } catch (error) {
    result.success = false;
    result.checks.push({ key: 'sender_addresses', status: 'error', message: error.message || 'Afzenderadressen konden niet worden opgehaald.' });
    return res.status(200).json(result);
  }

  try {
    const senderAddress = await findSenderAddressForStore(store);
    result.matchedSenderAddress = {
      id: senderAddress.id,
      company_name: senderAddress.company_name || '',
      name: senderAddress.name || '',
      city: senderAddress.city || ''
    };
    result.checks.push({ key: 'sender_match', status: 'ok', message: `Afzenderadres gevonden voor ${store}.` });

    const method = await findDhlDropoffMethod(senderAddress.id);
    result.shippingMethod = {
      id: method.id,
      name: method.name || '',
      price: method.price || null
    };
    result.checks.push({ key: 'shipping_method', status: 'ok', message: `Verzendmethode gevonden: ${method.name || method.id}.` });
  } catch (error) {
    result.success = false;
    result.checks.push({ key: 'sender_or_method', status: 'error', message: error.message || 'Afzenderadres of verzendmethode niet gevonden.' });
  }

  return res.status(200).json(result);
}
