import { sendVoucherEmail } from '../../../lib/voucher-mailer.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const incoming = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return incoming === adminToken;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET/POST is toegestaan.'
    });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  const body = req.body || {};

  const to = String(req.query.to || body.to || '').trim();
  const customerName = String(req.query.name || body.customerName || 'Test klant').trim();

  if (!to) {
    return res.status(400).json({
      success: false,
      message: 'Geef een test e-mailadres mee met ?to=email@voorbeeld.nl'
    });
  }

  try {
    const result = await sendVoucherEmail({
      to,
      customerName,
      voucherCode: `TEST-${Date.now().toString().slice(-6)}`,
      amount: Number(req.query.amount || body.amount || 25),
      currency: 'EUR',
      validFrom: new Date().toISOString().slice(0, 10),
      validTo: new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString().slice(0, 10),
      shopifyEnabled: String(req.query.shopifyEnabled || 'true') !== 'false',
      note: 'Dit is een testmail vanuit het GENTS winkelportaal.'
    });

    return res.status(200).json({
      success: true,
      message: `Testmail verstuurd naar ${to}.`,
      result
    });
  } catch (error) {
    console.error('Voucher test mail error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Testmail kon niet worden verstuurd.',
      hint: 'Controleer RESEND_API_KEY en MAIL_FROM / RESEND_FROM_EMAIL in Vercel.'
    });
  }
}
