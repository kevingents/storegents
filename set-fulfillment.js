import { checkVoucher, getCustomerVouchers } from '../../lib/srs-vouchers-client.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });

  try {
    const barcode = String(req.query.barcode || '').trim();
    const customerId = String(req.query.customerId || req.query.klantId || '').trim();

    if (barcode) {
      const voucher = await checkVoucher({ barcode });
      return res.status(200).json({ success: true, voucher });
    }

    if (customerId) {
      const vouchers = await getCustomerVouchers({ customerId });
      return res.status(200).json({ success: true, customerId, vouchers });
    }

    return res.status(400).json({ success: false, message: 'Vul barcode of customerId in.' });
  } catch (error) {
    console.error('Check voucher error:', error);
    return res.status(error.status || 500).json({ success: false, message: error.message || 'Voucher kon niet worden gecontroleerd.', details: error.fault || null });
  }
}
