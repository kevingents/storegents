import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getAutomationState } from '../../../lib/automation-state-store.js';
import { getMailLogs } from '../../../lib/mail-log-store.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const state = await getAutomationState();
  const logs = await getMailLogs();
  const pickupLogs = logs.filter((log) => String(log.type || '').startsWith('pickup'));
  const weborderLogs = logs.filter((log) => String(log.type || '').startsWith('weborder'));

  return res.status(200).json({
    success: true,
    automations: [
      {
        key: 'pickup-mail-automation',
        label: 'Pickup mail automatisering',
        enabled: Boolean(process.env.PICKUP_MAIL_SECRET && process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL),
        lastRunAt: state.pickup?.lastRunAt || '',
        lastStatus: state.pickup?.lastStatus || 'unknown',
        sentCount: pickupLogs.filter((log) => log.status === 'sent').length,
        errorCount: pickupLogs.filter((log) => log.status === 'error').length
      },
      {
        key: 'weborder-mail-automation',
        label: 'Weborder deadline mail automatisering',
        enabled: Boolean(process.env.WEBORDER_MAIL_SECRET && process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL),
        lastRunAt: state.weborder?.lastRunAt || '',
        lastStatus: state.weborder?.lastStatus || 'unknown',
        sentCount: weborderLogs.filter((log) => log.status === 'sent').length,
        errorCount: weborderLogs.filter((log) => log.status === 'error').length
      }
    ]
  });
}
