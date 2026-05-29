import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function apiBase(req) {
  /* Volgorde i.v.m. Vercel Deployment Protection: VERCEL_URL is de
     deployment-specifieke URL die Protection blokkeert met een HTML 401.
     De host waarmee de browser de portal opende is het publieke alias.
     Dus: expliciete publieke base eerst, dan de request-host, VERCEL_URL last. */
  const explicit = String(process.env.PUBLIC_API_BASE_URL || process.env.GENTS_API_BASE_URL || '').trim();
  if (explicit) return explicit.startsWith('http') ? explicit.replace(/\/$/, '') : `https://${explicit.replace(/\/$/, '')}`;
  if (req.headers.host) {
    const proto = req.headers['x-forwarded-proto'] || 'https';
    return `${proto}://${req.headers.host}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL.replace(/\/$/, '')}`;
  return '';
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
    const headers = { 'x-admin-token': process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random())) };
    /* Bypass-secret meesturen voor het geval de base toch een beschermde URL is. */
    const bypass = String(process.env.VERCEL_AUTOMATION_BYPASS_SECRET || process.env.VERCEL_PROTECTION_BYPASS || '').trim();
    if (bypass) headers['x-vercel-protection-bypass'] = bypass;
    const response = await fetch(`${baseUrl}/api/srs/open-weborders?store=${encodeURIComponent(store)}&t=${Date.now()}`, { headers });
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
