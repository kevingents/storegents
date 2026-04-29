import { getSrsFulfillments } from '../../lib/srs-client.js';
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
    const orderNr = String(req.query.orderNr || req.query.order || '').trim();

    if (!orderNr) {
      return res.status(400).json({
        success: false,
        message: 'SRS OrderNr ontbreekt.'
      });
    }

    const data = await getSrsFulfillments(orderNr);

    return res.status(200).json({
      success: true,
      orderNr,
      fulfillments: data.fulfillments
    });
  } catch (error) {
    console.error('SRS get fulfillments error:', error);

    return res.status(error.status || 500).json({
      success: false,
      message: error.message || 'SRS fulfillments konden niet worden opgehaald.',
      details: error.fault || null
    });
  }
}
