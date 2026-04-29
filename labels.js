import loyaltyRunHandler from '../admin/vouchers/loyalty-run.js';

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
      employeeName: 'Dagelijkse automatische voucher-run',
      reference: `GENTS-loyalty-${new Date().toISOString().slice(0, 10)}`,
      dryRun: String(req.query.dryRun || '') === 'true',
      makeAvailableInShopify: String(process.env.LOYALTY_VOUCHER_CREATE_SHOPIFY_GIFTCARDS || '') === 'true',
      sendEmail: String(process.env.LOYALTY_VOUCHER_SEND_EMAIL || 'true') !== 'false'
    };
  }

  return loyaltyRunHandler(req, res);
}
