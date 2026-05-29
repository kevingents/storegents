import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { getBirthdayProfilesFor } from '../../lib/user-profile-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';
import { getStoreMailAsync } from '../../lib/gents-mail-config.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

/**
 * Verjaardags-cron: dagelijks 07:00 UTC. Voor elke jarige gebruiker
 * stuurt een notificatie-mail naar de winkel-email (voor employees)
 * of naar SUPPORT_EMAIL (voor admin).
 *
 * Schedule wordt geconfigureerd in vercel.json:
 *   { "path": "/api/cron/birthday-notifications", "schedule": "0 7 * * *" }
 *
 * Auth: cron-secret OF admin-token (admin mag handmatig dry-runnen).
 */

function isAuthorized(req) {
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const givenAdmin = String(
    req.headers['x-admin-token'] ||
    req.query.adminToken ||
    req.query.admin_token ||
    ''
  ).replace(/^Bearer\s+/i, '').trim();
  if (adminToken && givenAdmin && adminToken === givenAdmin) return true;

  const cronSecret = String(process.env.BIRTHDAY_CRON_SECRET || process.env.CRON_SECRET || '').trim();
  const givenCron = String(
    req.query.secret || req.headers.authorization || ''
  ).replace(/^Bearer\s+/i, '').trim();
  return Boolean(cronSecret && givenCron && cronSecret === givenCron);
}

function getSupportEmail() {
  return String(process.env.SUPPORT_EMAIL || process.env.ADMIN_EMAIL || '').trim();
}

function esc(v) {
  return String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const dryRun = String(req.query.dryRun || '') === '1';

  try {
    const today = new Date();
    const jarigen = await getBirthdayProfilesFor(today);

    if (!jarigen.length) {
      return res.status(200).json({
        success: true,
        date: today.toISOString().slice(0, 10),
        count: 0,
        message: 'Niemand jarig vandaag.'
      });
    }

    const results = [];

    for (const profile of jarigen) {
      /* Bepaal ontvanger: voor employee = winkel-email, voor admin = SUPPORT_EMAIL */
      let to = '';
      if (profile.role === 'admin') {
        to = getSupportEmail();
      } else {
        const mail = await getStoreMailAsync(profile.store);
        to = mail?.email || '';
      }

      if (!to) {
        results.push({ name: profile.name, store: profile.store, sent: false, reason: 'Geen ontvanger-email' });
        continue;
      }

      const yearsOld = profile.birthday
        ? today.getFullYear() - Number(profile.birthday.slice(0, 4))
        : null;
      const ageHint = (yearsOld && yearsOld > 0 && yearsOld < 120) ? ` (${yearsOld} jaar)` : '';

      const html = baseMailHtml({
        title: `🎂 ${profile.name} is vandaag jarig!`,
        intro: `Een kleine reminder vanuit het GENTS Winkelportaal: vandaag is ${esc(profile.name)} jarig${esc(ageHint)}.`,
        bodyHtml: `
          <div style="padding:16px;background:#fef3c7;border-left:4px solid #f59e0b;border-radius:8px;font-size:14px;line-height:1.6">
            <strong style="display:block;font-size:18px;margin-bottom:6px;color:#92400e">🎉 ${esc(profile.name)} is vandaag jarig!</strong>
            ${profile.store ? `<div style="margin-top:8px"><strong>Winkel:</strong> ${esc(profile.store)}</div>` : ''}
            ${ageHint ? `<div><strong>Leeftijd:</strong>${esc(ageHint)}</div>` : ''}
          </div>
          <p style="margin-top:14px;font-size:13px;color:#3a4a5a">Vergeet niet om felicitaties uit te delen. Een kleine attentie of een persoonlijk berichtje maakt verschil.</p>
        `,
        footer: 'Automatisch verstuurd vanuit het GENTS Winkelportaal · verjaardags-cron.'
      });

      if (dryRun) {
        results.push({ name: profile.name, store: profile.store, to, sent: false, dryRun: true });
        continue;
      }

      try {
        await sendMail({
          to,
          subject: `🎂 ${profile.name} is vandaag jarig${ageHint}`,
          html,
          text: `${profile.name}${ageHint} is vandaag jarig.${profile.store ? ` Winkel: ${profile.store}.` : ''}`
        });
        results.push({ name: profile.name, store: profile.store, to, sent: true });
      } catch (error) {
        results.push({ name: profile.name, store: profile.store, sent: false, reason: error.message || 'mail-fout' });
      }
    }

    return res.status(200).json({
      success: true,
      date: today.toISOString().slice(0, 10),
      count: jarigen.length,
      dryRun,
      results
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: error.message || 'Cron-fout.' });
  }
}

export default trackedCron('birthday-notifications', handler);
