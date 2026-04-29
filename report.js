import { setFulfillmentBranch } from '../../lib/srs-weborders-message-client.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });

  try {
    const body = req.body || {};
    const result = await setFulfillmentBranch({
      fulfillmentId: body.fulfillmentId,
      branchId: body.branchId
    });

    return res.status(200).json({ success: true, message: 'Leveropdracht is naar ander filiaal gezet.', result });
  } catch (error) {
    console.error('Set fulfillment error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Leveropdracht kon niet worden aangepast.', details: error.fault || null });
  }
}
