import { getOpenVoucherLogsForReminders } from '../../../lib/voucher-log-store.js';
import { handleCors, setCorsHeaders } from '../../../lib/cors.js';

function isAuthorized(req) {
  const adminToken = process.env.ADMIN_TOKEN || '12345';
  return req.headers['x-admin-token'] === adminToken;
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const one = new Date(dateOnly(a));
  const two = new Date(dateOnly(b));
  return Math.round((two - one) / 86400000);
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);

  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const logs = await getOpenVoucherLogsForReminders();
  const today = new Date();

  const rows = logs.map((log) => {
    const daysUntilExpiry = log.validTo ? daysBetween(today, log.validTo) : null;
    const daysSinceCreated = log.createdAt ? daysBetween(log.createdAt, today) : null;

    return {
      voucherCode: log.voucherCode,
      customerName: log.customerName,
      customerEmail: log.customerEmail,
      amount: log.amount,
      validTo: log.validTo,
      daysUntilExpiry,
      daysSinceCreated,
      oneMonthReminderSent: Boolean(log.reminderOneMonthSentAt),
      expiryReminderSent: Boolean(log.reminderExpiryWeekSentAt),
      lastReminderError: log.lastReminderError || ''
    };
  });

  return res.status(200).json({
    success: true,
    openCount: rows.length,
    dueOneMonth: rows.filter((row) => row.daysSinceCreated >= 30 && !row.oneMonthReminderSent).length,
    dueExpiryWeek: rows.filter((row) => row.daysUntilExpiry !== null && row.daysUntilExpiry <= 7 && row.daysUntilExpiry >= 0 && !row.expiryReminderSent).length,
    rows
  });
}
