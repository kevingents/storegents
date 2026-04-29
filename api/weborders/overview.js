import {
  getWeborderRequests,
  summarizeOpenWeborders,
  updateWeborderRequest
} from '../../lib/weborder-request-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);

  try {
    if (req.method === 'POST') {
      const body = req.body || {};
      const id = field(body.id) || field(body.orderId);

      if (!id) {
        return res.status(400).json({
          success: false,
          message: 'id of orderId ontbreekt.'
        });
      }

      const updated = await updateWeborderRequest(id, {
        status: field(body.status) || 'afgerond',
        trackingNumber: field(body.trackingNumber),
        sendcloudLabelUrl: field(body.sendcloudLabelUrl),
        note: field(body.note)
      });

      if (!updated) {
        return res.status(404).json({
          success: false,
          message: 'Weborder niet gevonden.'
        });
      }

      return res.status(200).json({
        success: true,
        record: updated
      });
    }

    if (req.method !== 'GET') {
      return res.status(405).json({
        success: false,
        message: 'Alleen GET of POST is toegestaan.'
      });
    }

    const store = String(req.query.store || '').trim();
    const requests = await getWeborderRequests();

    const summary = store
      ? summarizeOpenWeborders(requests, store)
      : null;

    return res.status(200).json({
      success: true,
      store,
      summary,
      requests: store
        ? requests.filter((item) => item.sellingStore === store || item.fulfilmentStore === store).slice(0, 100)
        : requests.slice(0, 200)
    });
  } catch (error) {
    console.error('Weborder overview error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Weborder overzicht kon niet worden opgehaald.'
    });
  }
}
