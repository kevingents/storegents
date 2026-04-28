import { getSenderAddresses } from '../../lib/sendcloud-client.js';
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
    const addresses = await getSenderAddresses();

    return res.status(200).json({
      success: true,
      sender_addresses: addresses
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      details: error.data || null
    });
  }
}
