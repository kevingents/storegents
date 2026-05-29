/**
 * Cron: takenplanner — dagelijkse herinneringen.
 *
 * 1. Genereert taak-instanties voor alle actieve taken die vandaag vervallen.
 * 2. Verzamelt per ontvanger (persoon-email of groep-emails) de nieuwe taken
 *    en stuurt één herinneringsmail. De taak verschijnt óók in "Mijn taken" in
 *    de portal (dat is de in-portal melding).
 *
 * Draait dagelijks; idempotent dankzij generateDueInstances (1 instantie per
 * taak per dag), dus meerdere runs op dezelfde dag dupliceren niks.
 */

import { trackedCron } from '../../lib/cron-auto-track.js';
import { generateDueInstances, todayNL } from '../../lib/taken-store.js';
import { getAllOfficeUsers } from '../../lib/office-users-store.js';
import { resolveGroupMails } from '../../lib/user-groups-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

function isAuthorized(req) {
  const cronSecret = process.env.CRON_SECRET || '';
  if (!cronSecret) return true;
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return token === cronSecret || req.query.secret === cronSecret;
}

async function handler(req, res) {
  if (!['GET', 'POST'].includes(req.method)) {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }
  if (!isAuthorized(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  const dryRun = String(req.query.dryRun || '') === 'true';
  const date = req.query.date || todayNL();

  /* 1. Instanties genereren (bij dryRun niet schrijven → leeg) */
  const created = dryRun ? [] : await generateDueInstances(date);

  /* 2. Ontvangers resolven: office-users map (userId → email) */
  const office = await getAllOfficeUsers().catch(() => ({}));
  const officeById = office || {};
  const emailForUser = (userId) => {
    const u = officeById[userId];
    return u && u.active !== false && u.email ? String(u.email).toLowerCase() : null;
  };
  const resolveMember = async (memberId) => emailForUser(memberId);

  /* 3. Per ontvanger de nieuwe taken bundelen */
  const byEmail = new Map(); /* email → { tasks: [titel] } */
  for (const inst of created) {
    let emails = [];
    if (inst.assignType === 'user') {
      const e = emailForUser(inst.assigneeId);
      if (e) emails = [e];
    } else if (inst.assignType === 'group') {
      emails = await resolveGroupMails(inst.assigneeId, resolveMember).catch(() => []);
    }
    for (const e of emails) {
      if (!byEmail.has(e)) byEmail.set(e, { tasks: [] });
      byEmail.get(e).tasks.push(inst.title);
    }
  }

  if (dryRun) {
    return res.status(200).json({
      success: true, dryRun: true, date,
      wouldCreate: created.length,
      recipients: [...byEmail.keys()]
    });
  }

  /* 4. Mails versturen */
  const results = [];
  for (const [email, data] of byEmail.entries()) {
    try {
      const items = data.tasks.map((t) => `<li style="margin-bottom:6px">${String(t).replace(/[<>&]/g, '')}</li>`).join('');
      const html = baseMailHtml({
        title: 'Je taken voor vandaag',
        intro: 'Dit zijn de terugkerende taken die vandaag op je lijst staan in het GENTS portaal.',
        bodyHtml: `<ul style="padding-left:18px;margin:0 0 16px">${items}</ul>
          <p style="margin:0;color:#475569;font-size:13px">Vink ze af onder <strong>Mijn taken</strong> in het portaal zodra ze klaar zijn.</p>`,
        footer: 'GENTS portaal — takenplanner'
      });
      await sendMail({
        to: email,
        subject: `Taken voor vandaag (${data.tasks.length})`,
        html,
        text: `Je taken voor vandaag:\n- ${data.tasks.join('\n- ')}\n\nVink ze af onder Mijn taken in het GENTS portaal.`
      });
      results.push({ email, tasks: data.tasks.length, sent: true });
    } catch (e) {
      results.push({ email, sent: false, error: e.message });
    }
  }

  return res.status(200).json({
    success: true,
    date,
    created: created.length,
    mailed: results.filter((r) => r.sent).length,
    failed: results.filter((r) => !r.sent).length,
    results
  });
}

export default trackedCron('taken-reminders', handler);
