import {
  getOpenVoucherLogsForReminders,
  updateVoucherLogByCode
} from '../../lib/voucher-log-store.js';
import { sendVoucherReminderEmail } from '../../lib/voucher-mailer.js';

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  if (!cronSecret) return true;

  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');

  return token === cronSecret || req.query.secret === cronSecret;
}

function dateOnly(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function daysBetween(a, b) {
  const one = new Date(dateOnly(a));
  const two = new Date(dateOnly(b));
  return Math.round((two - one) / 86400000);
}

function shouldSendOneMonthReminder(log, today) {
  if (log.reminderOneMonthSentAt) return false;
  if (!log.createdAt) return false;

  const createdDate = new Date(log.createdAt);
  const dueDate = addDays(createdDate, 30);

  return dateOnly(today) >= dateOnly(dueDate);
}

function shouldSendExpiryWeekReminder(log, today) {
  if (log.reminderExpiryWeekSentAt) return false;
  if (!log.validTo) return false;

  const days = daysBetween(today, log.validTo);

  return days <= 7 && days >= 0;
}

async function sendReminder(log, reminderType) {
  await sendVoucherReminderEmail({
    to: log.customerEmail,
    customerName: log.customerName,
    voucherCode: log.voucherCode,
    amount: log.amount,
    currency: log.currency || 'EUR',
    validFrom: log.validFrom,
    validTo: log.validTo,
    shopifyEnabled: Boolean(log.shopifyEnabled),
    note: log.note,
    reminderType
  });

  const updates = {
    lastReminderError: ''
  };

  if (reminderType === 'one_month') {
    updates.reminderOneMonthSentAt = new Date().toISOString();
  }

  if (reminderType === 'expiry_7_days') {
    updates.reminderExpiryWeekSentAt = new Date().toISOString();
  }

  return updateVoucherLogByCode(log.voucherCode, updates);
}

export default async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({
      success: false,
      message: 'Alleen GET of POST is toegestaan.'
    });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: 'Niet bevoegd.'
    });
  }

  const dryRun = String(req.query.dryRun || '') === 'true';
  const today = new Date();
  const logs = await getOpenVoucherLogsForReminders();

  const candidates = [];

  logs.forEach((log) => {
    if (shouldSendOneMonthReminder(log, today)) {
      candidates.push({ log, reminderType: 'one_month' });
    }

    if (shouldSendExpiryWeekReminder(log, today)) {
      candidates.push({ log, reminderType: 'expiry_7_days' });
    }
  });

  if (dryRun) {
    return res.status(200).json({
      success: true,
      dryRun: true,
      count: candidates.length,
      candidates: candidates.map((item) => ({
        voucherCode: item.log.voucherCode,
        customerEmail: item.log.customerEmail,
        reminderType: item.reminderType,
        validTo: item.log.validTo,
        createdAt: item.log.createdAt
      }))
    });
  }

  const results = [];

  for (const candidate of candidates) {
    try {
      const updated = await sendReminder(candidate.log, candidate.reminderType);
      results.push({
        success: true,
        voucherCode: candidate.log.voucherCode,
        customerEmail: candidate.log.customerEmail,
        reminderType: candidate.reminderType,
        updated
      });
    } catch (error) {
      await updateVoucherLogByCode(candidate.log.voucherCode, {
        lastReminderError: error.message || 'Reminder verzenden mislukt.'
      });

      results.push({
        success: false,
        voucherCode: candidate.log.voucherCode,
        customerEmail: candidate.log.customerEmail,
        reminderType: candidate.reminderType,
        error: error.message
      });
    }
  }

  return res.status(200).json({
    success: true,
    processed: results.length,
    sent: results.filter((item) => item.success).length,
    failed: results.filter((item) => !item.success).length,
    results
  });
}
