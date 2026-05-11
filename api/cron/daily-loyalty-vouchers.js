import generateEligibleVouchersHandler from '../admin/points/generate-eligible-vouchers.js';

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  if (!cronSecret) return true;

  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');

  return token === cronSecret || req.query.secret === cronSecret;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  req.headers['x-admin-token'] = process.env.ADMIN_TOKEN || '12345';

  if (req.method === 'GET') {
    req.method = 'POST';
    req.body = {
      store: 'GENTS Administratie',
      employeeName: 'Dagelijkse automatische spaarpunten-voucher-run',
      dryRun: String(req.query.dryRun || process.env.LOYALTY_VOUCHER_CRON_DRY_RUN || 'false') === 'true',
      sendEmail: String(process.env.LOYALTY_VOUCHER_SEND_EMAIL || 'true') !== 'false',
      redeemPoints: String(process.env.LOYALTY_VOUCHER_REDEEM_POINTS || 'false') === 'true',
      allowDuplicates: false,
      customerFrom: String(process.env.POINTS_SYNC_CUSTOMER_FROM || '1'),
      customerTo: String(process.env.POINTS_SYNC_CUSTOMER_TO || '999999999'),
      dateFrom: String(process.env.POINTS_SYNC_DATE_FROM || '2000-01-01'),
      dateTo: new Date().toISOString().slice(0, 10),
      limit: Number(process.env.LOYALTY_VOUCHER_CRON_LIMIT || 50),
      duplicateWindowDays: Number(process.env.LOYALTY_VOUCHER_DUPLICATE_WINDOW_DAYS || 120)
    };
  }

  return generateEligibleVouchersHandler(req, res);
}
