import { getVoucherGroups } from '../../lib/srs-vouchers-client.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const groups = await getVoucherGroups();
    return res.status(200).json({ success: true, groups });
  } catch (error) {
    console.error('Get voucher groups error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Vouchergroepen konden niet worden opgehaald.', details: error.fault || null });
  }
}
