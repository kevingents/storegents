import { getMailLog, monthlyStats } from '../../lib/gents-mail-log-store.js';
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
  const date = String(row.createdAt || row.sentAt || '').slice(0, 10);
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const from = String(req.query.dateFrom || req.query.from || '').slice(0, 10);
  const to = String(req.query.dateTo || req.query.to || '').slice(0, 10);
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit || 250)));
  const type = String(req.query.type || '').trim();
  const store = String(req.query.store || '').trim();

  const rows = (await getMailLog()).filter((row) => {
    if (!inRange(row, from, to)) return false;
    if (type && row.type !== type) return false;
    if (store && row.store !== store) return false;
    return true;
  });

  const stats = monthlyStats(rows, from || undefined, to || undefined);
  const errors = rows.filter((row) => row.status === 'error').length;
  const sent = rows.filter((row) => row.status === 'sent' || row.status === 'success').length;

  return res.status(200).json({
    success: true,
    provider: 'resend',
    configured: Boolean(process.env.RESEND_API_KEY),
    from: process.env.RESEND_FROM_EMAIL || process.env.MAIL_FROM || 'GENTS Winkelportaal <noreply@gents.nl>',
    total: rows.length,
    sent,
    errors,
    rows: rows.slice(0, limit),
    stats
  });
}
