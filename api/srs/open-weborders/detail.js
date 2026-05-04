import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function apiBase(req) {
  const configured = process.env.PUBLIC_API_BASE_URL || process.env.VERCEL_URL || '';
  if (configured) return configured.startsWith('http') ? configured.replace(/\/$/, '') : `https://${configured.replace(/\/$/, '')}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return `${proto}://${req.headers.host}`;
}

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
    const baseUrl = apiBase(req);
    const response = await fetch(`${baseUrl}/api/srs/open-weborders?store=${encodeURIComponent(store)}&t=${Date.now()}`, {
      headers: { 'x-admin-token': process.env.ADMIN_TOKEN || '12345' }
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.success === false) throw new Error(data.message || 'Openstaande orders konden niet worden geladen.');
    const rows = data.requests || [];
    const row = rows.find((item) => rowId(item) === id || String(item.orderNr || item.orderNumber || item.orderId || '') === id);
    if (!row) return res.status(404).json({ success: false, message: 'Orderregel niet gevonden.' });
    return res.status(200).json({ success: true, order: row });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Orderdetail kon niet worden geladen.' });
  }
}
