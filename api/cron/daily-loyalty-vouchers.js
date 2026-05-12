import loyaltyVoucherRunHandler from '../admin/vouchers/loyalty-run.js';

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  if (!cronSecret) return true;

  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');

  return token === cronSecret || req.query.secret === cronSecret;
}

function currentHourReference() {
  const now = new Date();
  return `GENTS-loyalty-auto-${now.toISOString().slice(0, 13).replace(/:/g, '')}`;
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  req.headers['x-admin-token'] = process.env.ADMIN_TOKEN || '12345';
  req.method = 'POST';

  req.body = {
    store: 'GENTS Administratie',
    employeeName: 'Automatische spaarpunten-voucher-cron',
    reference: String(req.query.reference || currentHourReference()),
    dryRun: String(req.query.dryRun || process.env.LOYALTY_VOUCHER_CRON_DRY_RUN || 'false') === 'true',
    sendEmail: String(process.env.LOYALTY_VOUCHER_SEND_EMAIL || 'true') !== 'false',
    makeAvailableInShopify: String(process.env.LOYALTY_VOUCHER_SHOPIFY || 'true') !== 'false',
    allowDuplicateReference: false,
    customerIds: String(req.query.customerIds || '')
      .split(/[\s,;|]+/)
      .map((id) => id.trim())
      .filter(Boolean)
  };

  return loyaltyVoucherRunHandler(req, res);
}
