import { handleCors, setCorsHeaders } from '../../../lib/cors.js';
import { fetchInternalApi } from '../../../lib/gents-mail-config.js';

function rowId(row) {
  return String(row.fulfillmentId || row.id || `${row.orderNr || row.orderNumber || row.orderId || ''}-${row.sku || row.barcode || ''}`).trim();
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const store = String(req.query.store || '').trim();
    const id = String(req.query.id || '').trim();
    if (!store || !id) return res.status(400).json({ success: false, message: 'Winkel en id zijn verplicht.' });
    /* Centrale helper: base-URL + x-admin-token + Deployment-Protection bypass
       + HTML-respons-detectie op één plek (lib/gents-mail-config.js). */
    const data = await fetchInternalApi(req, `/api/srs/open-weborders?store=${encodeURIComponent(store)}&t=${Date.now()}`);
    const rows = data.requests || [];
    const row = rows.find((item) => rowId(item) === id || String(item.orderNr || item.orderNumber || item.orderId || '') === id);
    if (!row) return res.status(404).json({ success: false, message: 'Orderregel niet gevonden.' });
    return res.status(200).json({ success: true, order: row });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Orderdetail kon niet worden geladen.' });
  }
}
