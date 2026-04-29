import { getWeborderRequests, summarizeOpenWeborders } from '../../lib/weborder-request-store.js';
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

  const store = String(req.query.store || '').trim();
  const requests = await getWeborderRequests();
  const summary = store ? summarizeOpenWeborders(requests, store) : null;

  return res.status(200).json({
    success: true,
    source: 'local_weborder_tool_log',
    note: 'Dit telt weborders die via de winkel-weborder tool zijn aangemaakt. Koppel hier later eventueel de SRS open fulfillment endpoint aan.',
    summary,
    open: summary?.totalOpenCount || 0,
    requests: store ? [...(summary?.sellingOpen || []), ...(summary?.fulfilmentOpen || [])] : requests
  });
}
