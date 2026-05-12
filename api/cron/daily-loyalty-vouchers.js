import loyaltyVoucherRunHandler from '../admin/vouchers/loyalty-run.js';

const CRON_BUILD = 'daily-loyalty-vouchers-safe-v2-2026-05-12';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  const header = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const querySecret = String(req.query.secret || req.query.adminToken || '').trim();
  const headerAdmin = String(req.headers['x-admin-token'] || '').trim();

  if (cronSecret && (header === cronSecret || querySecret === cronSecret || headerAdmin === cronSecret)) return true;
  if (adminToken && (header === adminToken || querySecret === adminToken || headerAdmin === adminToken)) return true;

  // Vercel cron requests are allowed, but live execution is still controlled
  // by LOYALTY_VOUCHER_CRON_LIVE / ?live=true below.
  if (req.headers['x-vercel-cron']) return true;

  return false;
}

function currentHourReference() {
  const now = new Date();
  return `GENTS-loyalty-auto-${now.toISOString().slice(0, 13).replace(/:/g, '')}`;
}

function isLiveRun(req) {
  const explicitLive = String(req.query.live || '').toLowerCase() === 'true';
  const envLive = String(process.env.LOYALTY_VOUCHER_CRON_LIVE || '').toLowerCase() === 'true';

  // Safety default: cron/manual cron endpoint does NOT create vouchers unless
  // explicitly enabled. This prevents accidental live conversions while testing
  // from Shopify console or while a stale Vercel deployment is still active.
  return explicitLive || envLive;
}

export default async function handler(req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, build: CRON_BUILD, message: 'Alleen GET of POST is toegestaan.' });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, build: CRON_BUILD, message: 'Niet bevoegd.' });
  }

  const live = isLiveRun(req);
  const dryRun = !live || String(req.query.dryRun || '').toLowerCase() === 'true';

  req.headers['x-admin-token'] = process.env.ADMIN_TOKEN || String(req.query.secret || '12345');
  req.method = 'POST';

  req.body = {
    store: 'GENTS Administratie',
    employeeName: live ? 'Automatische spaarpunten-voucher-cron' : 'Automatische spaarpunten-voucher-cron dry-run',
    reference: String(req.query.reference || currentHourReference()),
    dryRun,
    sendEmail: live && String(process.env.LOYALTY_VOUCHER_SEND_EMAIL || 'true') !== 'false',
    makeAvailableInShopify: live && String(process.env.LOYALTY_VOUCHER_SHOPIFY || 'true') !== 'false',
    allowDuplicateReference: false,
    customerIds: String(req.query.customerIds || '')
      .split(/[\s,;|]+/)
      .map((id) => id.trim())
      .filter(Boolean)
  };

  const originalJson = res.json.bind(res);
  res.json = (payload) => originalJson({
    build: CRON_BUILD,
    cronLive: live,
    cronDryRun: dryRun,
    ...payload
  });

  return loyaltyVoucherRunHandler(req, res);
}
