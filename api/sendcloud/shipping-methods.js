import { findSenderAddressForStore, getShippingMethods } from '../../lib/sendcloud-client.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET is toegestaan.'
    });
  }

  try {
    const store = String(req.query.store || '').trim();
    let senderAddressId = req.query.sender_address || '';

    if (!senderAddressId && store) {
      const senderAddress = await findSenderAddressForStore(store);
      senderAddressId = senderAddress.id;
    }

    const methods = await getShippingMethods({
      sender_address: senderAddressId,
      to_country: req.query.to_country || 'NL'
    });

    return res.status(200).json({
      success: true,
      sender_address: senderAddressId,
      shipping_methods: methods
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      details: error.data || null
    });
  }
}
