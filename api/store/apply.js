/**
 * POST /api/store/apply — publieke sollicitatie (vanaf de website).
 *
 * Body: { vacancyId, name, email, phone, motivation, cvUrl?, cvFilename?, consent }
 *   consent (AVG) is verplicht.
 *
 * Maakt een sollicitant aan, stuurt een in-portal melding ("nieuwe aanmelding")
 * en — als HR_NOTIFY_EMAIL gezet is — een e-mail naar HR. Open POST.
 */

import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { createApplicant } from '../../lib/recruitment-store.js';
import { createNotification } from '../../lib/store-notifications-store.js';
import { sendMail, baseMailHtml } from '../../lib/gents-mailer.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}
const esc = (s) => String(s == null ? '' : s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });

  try {
    const body = parseBody(req);
    if (!String(body.name || '').trim()) return res.status(400).json({ success: false, message: 'Naam is verplicht.' });
    if (!String(body.email || '').trim()) return res.status(400).json({ success: false, message: 'E-mail is verplicht.' });
    if (!body.consent) return res.status(400).json({ success: false, message: 'Toestemming (AVG) is verplicht om te kunnen solliciteren.' });

    const a = await createApplicant({ ...body, source: 'website' });

    /* Melding bij nieuwe aanmelding (in-portal). */
    try {
      await createNotification({
        target: a.store ? undefined : 'all',
        stores: a.store ? [a.store] : undefined,
        title: 'Nieuwe sollicitatie',
        body: `${a.name} solliciteerde op "${a.vacancyTitle || 'onbekende vacature'}"${a.store ? ` (${a.store})` : ''}.`,
        severity: 'info',
        link: 'hr-vacatures',
        createdBy: 'systeem'
      });
    } catch (e) { console.warn('[store/apply] notify', e.message); }

    /* Optionele HR-mail. */
    try {
      const to = String(process.env.HR_NOTIFY_EMAIL || '').trim();
      if (to) {
        await sendMail({
          to,
          subject: `Nieuwe sollicitatie: ${a.vacancyTitle || a.name}`,
          html: baseMailHtml({
            title: 'Nieuwe sollicitatie',
            intro: `${esc(a.name)} heeft gesolliciteerd via de website.`,
            bodyHtml: `<p><strong>Vacature:</strong> ${esc(a.vacancyTitle || '-')}<br>
              <strong>Winkel:</strong> ${esc(a.store || '-')}<br>
              <strong>E-mail:</strong> ${esc(a.email)}<br>
              <strong>Telefoon:</strong> ${esc(a.phone || '-')}</p>
              <p><strong>Motivatie:</strong><br>${esc(a.motivation || '-')}</p>
              ${a.cvUrl ? `<p><a href="${esc(a.cvUrl)}">CV bekijken</a></p>` : ''}`
          })
        });
      }
    } catch (e) { console.warn('[store/apply] mail', e.message); }

    return res.status(200).json({ success: true, id: a.id, message: 'Bedankt voor je sollicitatie! We nemen zo snel mogelijk contact op.' });
  } catch (e) {
    console.error('[store/apply]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
