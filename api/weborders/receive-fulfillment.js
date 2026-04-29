import { receiveFulfillment } from '../../lib/srs-weborders-message-client.js';
import { updateWeborderRequest } from '../../lib/weborder-request-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST is toegestaan.' });

  try {
    const body = req.body || {};
    const result = await receiveFulfillment({
      orderNr: body.orderNr,
      branchId: body.branchId,
      orderLineNr: body.orderLineNr,
      sku: body.sku,
      personnelId: body.personnelId,
      binLocation: body.binLocation
    });

    if (body.fulfillmentId || body.orderNr) {
      await updateWeborderRequest(body.fulfillmentId || body.orderNr, {
        status: 'processed',
        srsResponse: { receiveFulfillment: result.status }
      }).catch(() => null);
    }

    return res.status(200).json({ success: true, message: 'Fulfillment is uitgeleverd in SRS.', result });
  } catch (error) {
    console.error('Receive fulfillment error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Fulfillment kon niet worden uitgeleverd.', details: error.fault || null });
  }
}
