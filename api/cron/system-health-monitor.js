import { evaluateAlerts } from '../../lib/system-alert-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

/**
 * Cron: GET /api/cron/system-health-monitor
 * Schedule: elke 5 minuten (* /5 * * * *)
 *
 * 1. Roept intern /api/admin/system-health aan
 * 2. Evalueert via system-alert-store welke services al ≥10 min storing hebben
 * 3. Stuurt e-mail notificatie via Resend bij nieuwe alerts of recovery
 *
 * Env-vars:
 *   ADMIN_TOKEN                  — voor interne API call
 *   RESEND_API_KEY               — voor mail
 *   SYSTEM_ALERT_RECIPIENT       — destination (default: SUPPORT_EMAIL)
 *   SYSTEM_ALERT_THRESHOLD_MIN   — default 10 (vanaf wanneer alerten)
 *   SYSTEM_ALERT_COOLDOWN_MIN    — default 60 (re-alert interval)
 */

function clean(value) { return String(value || '').trim(); }

function isAuthorized(req) {
  /* Vercel cron stuurt User-Agent: vercel-cron */
  const ua = String(req.headers['user-agent'] || '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  /* Handmatige trigger met admin token */
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const token = String(req.headers['x-admin-token'] || req.query.adminToken || '').trim();
  return token === adminToken;
}

async function sendAlertEmail(notifications) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'RESEND_API_KEY niet ingesteld' };
  const to = process.env.SYSTEM_ALERT_RECIPIENT || process.env.SUPPORT_EMAIL || 'klantenservice@gents.nl';
  const from = process.env.SYSTEM_ALERT_FROM || 'GENTS Portal <noreply@gents.nl>';

  const errors = notifications.filter((n) => n.severity === 'error');
  const warnings = notifications.filter((n) => n.severity === 'warning');
  const recovered = notifications.filter((n) => n.severity === 'recovered');

  const subject = errors.length
    ? `🚨 ${errors.length} storing(en) GENTS Portal`
    : warnings.length
      ? `⚠ ${warnings.length} waarschuwing(en) GENTS Portal`
      : `✓ ${recovered.length} service(s) hersteld`;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:20px">
      <h2 style="color:#0f172a;margin-bottom:14px">GENTS Portal — System Alert</h2>
      <p style="color:#475569;font-size:13px;line-height:1.5">
        ${errors.length ? `<strong style="color:#dc2626">${errors.length} storing(en).</strong>` : ''}
        ${warnings.length ? `<strong style="color:#d97706">${warnings.length} waarschuwing(en).</strong>` : ''}
        ${recovered.length ? `<strong style="color:#059669">${recovered.length} hersteld.</strong>` : ''}
      </p>

      ${errors.concat(warnings).map((n) => `
        <div style="margin:10px 0;padding:12px;background:${n.severity === 'error' ? '#fef2f2' : '#fffbeb'};border-left:3px solid ${n.severity === 'error' ? '#dc2626' : '#d97706'};border-radius:4px">
          <strong style="font-size:13px;color:${n.severity === 'error' ? '#dc2626' : '#92400e'}">${n.service}</strong>
          <p style="margin:4px 0 0;font-size:12px;color:#475569;line-height:1.5">${n.message}</p>
          ${n.notifyCount > 1 ? `<p style="margin:4px 0 0;font-size:10px;color:#94a3b8">Notificatie #${n.notifyCount}</p>` : ''}
        </div>
      `).join('')}

      ${recovered.map((n) => `
        <div style="margin:10px 0;padding:12px;background:#ecfdf5;border-left:3px solid #059669;border-radius:4px">
          <strong style="font-size:13px;color:#065f46">${n.service} — hersteld</strong>
          <p style="margin:4px 0 0;font-size:12px;color:#475569;line-height:1.5">${n.message}</p>
        </div>
      `).join('')}

      <p style="margin-top:20px;font-size:11px;color:#94a3b8">
        Verzonden door GENTS Portal System Monitor · cron draait elke 5 min ·
        Alert-threshold: ${process.env.SYSTEM_ALERT_THRESHOLD_MIN || 10} min ·
        Cooldown: ${process.env.SYSTEM_ALERT_COOLDOWN_MIN || 60} min.
      </p>
    </div>
  `;

  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to, subject, html })
  });
  const data = await resp.json().catch(() => ({}));
  return { sent: resp.ok, status: resp.status, id: data.id, error: !resp.ok ? data : null };
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  /* Roep system-health aan */
  const host = req.headers['host'];
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const baseUrl = `${proto}://${host}`;
  const adminToken = process.env.ADMIN_TOKEN || '';

  let healthData;
  try {
    const healthResp = await fetch(`${baseUrl}/api/admin/system-health?adminToken=${encodeURIComponent(adminToken)}&t=${Date.now()}`, {
      headers: { Accept: 'application/json' }
    });
    healthData = await healthResp.json();
    if (!healthResp.ok || !healthData.success) {
      throw new Error(healthData.message || `system-health gaf ${healthResp.status}`);
    }
  } catch (error) {
    return res.status(200).json({ success: false, message: `Health check mislukt: ${error.message}` });
  }

  const services = healthData.services || [];
  const { toNotify } = await evaluateAlerts(services);

  let mailResult = null;
  if (toNotify.length > 0) {
    mailResult = await sendAlertEmail(toNotify);
  }

  return res.status(200).json({
    success: true,
    servicesChecked: services.length,
    notificationsTriggered: toNotify.length,
    notifications: toNotify.map((n) => ({ service: n.service, severity: n.severity, notifyCount: n.notifyCount || 1 })),
    mailResult
  });
}

export default trackedCron('system-health-monitor', handler);
