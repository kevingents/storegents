import { cronStats, getCronLog } from '../../lib/gents-cron-log-store.js';
import { getMailLog } from '../../lib/gents-mail-log-store.js';
import { getAdminToken } from '../../lib/gents-mail-config.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isAuthorized(req) {
  const expected = getAdminToken() || String(process.env.ADMIN_TOKEN || '12345').trim();
  const given = String(
    req.headers['x-admin-token'] ||
    req.headers['x-admin-pin'] ||
    req.headers.authorization ||
    req.query.adminToken ||
    req.query.admin_token ||
    req.query.token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function inRange(row, from, to) {
  const date = String(row.createdAt || '').slice(0, 10);
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

function mailLogToCronRows(mailRows = []) {
  return mailRows
    .filter((row) => String(row.type || '').includes('weborder') || String(row.type || '').includes('pickup') || String(row.type || '').includes('region_manager'))
    .map((row) => {
      let job = 'mail-automation';
      if (String(row.type || '').includes('weborder')) job = 'weborder-mail-run';
      if (String(row.type || '').includes('pickup')) job = 'pickup-mail-run';
      if (String(row.type || '').includes('region_manager')) job = 'region-manager-weekly-report';
      return {
        id: `mail-${row.id || row.createdAt}`,
        createdAt: row.createdAt || row.sentAt,
        job,
        source: 'mail-log-derived',
        status: row.status === 'error' ? 'error' : 'success',
        message: row.message || row.order || row.key || '',
        meta: { type: row.type, store: row.store, recipient: row.recipient }
      };
    });
}

const CONFIGURED_CRONS = [
  { job: 'voucher-reminders', path: '/api/cron/voucher-reminders', schedule: '0 8 * * *' },
  { job: 'daily-loyalty-vouchers', path: '/api/cron/daily-loyalty-vouchers', schedule: '0 * * * *' },
  { job: 'sync-shopify-points', path: '/api/cron/sync-shopify-points', schedule: '0 * * * *' },
  { job: 'srs-cancellations-nightly', path: '/api/cron/srs-cancellations-nightly', schedule: '15 * * * *' },
  { job: 'srs-unavailable-hourly', path: '/api/cron/srs-unavailable-hourly', schedule: '20 * * * *' },
  { job: 'srs-cancelled-backfill-2026', path: '/api/cron/srs-cancelled-backfill-2026', schedule: '45 * * * *' },
  { job: 'srs-unavailable-lost-found-check', path: '/api/cron/srs-unavailable-lost-found-check', schedule: '30 6 * * 1,2' },
  { job: 'pickup-mail-run', path: '/api/cron/pickup-mail-run', schedule: '*/30 * * * *' },
  { job: 'weborder-mail-run', path: '/api/cron/weborder-mail-run', schedule: '0 8 * * *' },
  { job: 'region-manager-weekly-report', path: '/api/cron/region-manager-weekly-report', schedule: '0 8 * * 1' }
];

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const from = String(req.query.dateFrom || req.query.from || '').slice(0, 10);
  const to = String(req.query.dateTo || req.query.to || '').slice(0, 10);
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 250)));
  const job = String(req.query.job || '').trim();

  const explicitRows = await getCronLog();
  const derivedRows = mailLogToCronRows(await getMailLog());
  const rows = [...explicitRows, ...derivedRows]
    .filter((row) => {
      if (!inRange(row, from, to)) return false;
      if (job && row.job !== job) return false;
      return true;
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const stats = cronStats(rows);
  const errorCount = rows.filter((row) => row.status === 'error').length;
  const successCount = rows.length - errorCount;

  return res.status(200).json({
    success: true,
    configuredCrons: CONFIGURED_CRONS,
    total: rows.length,
    successCount,
    errorCount,
    stats,
    rows: rows.slice(0, limit),
    sources: {
      explicitCronLog: explicitRows.length,
      derivedFromMailLog: derivedRows.length
    }
  });
}
