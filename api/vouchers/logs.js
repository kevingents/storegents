import { getVoucherLogs } from '../../lib/voucher-log-store.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const store = String(req.query.store || '').trim();
    const admin = String(req.query.admin || '') === 'true';

    if (admin && !isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

    const logs = await getVoucherLogs();
    return res.status(200).json({ success: true, logs: admin ? logs : logs.filter((log) => log.store === store) });
  } catch (error) {
    console.error('Get voucher logs error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Voucherlog kon niet worden opgehaald.' });
  }
}
