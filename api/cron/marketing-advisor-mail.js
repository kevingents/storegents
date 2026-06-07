/**
 * /api/cron/marketing-advisor-mail
 *
 * Maandelijks: genereert het AI-marketingadvies (lib/marketing-advisor) en mailt
 * het naar de ingestelde ontvangers. Zo landt de bureau-beoordeling automatisch
 * in de inbox. Schema in vercel.json: "0 7 1 * *" (1e van de maand, 07:00).
 *
 * Ontvangers: env MARKETING_ADVISOR_EMAIL (komma-gescheiden). Override/test via
 * ?email=adres , ?period=maand|kwartaal , ?dryRun=1 (genereert maar verstuurt niet).
 *
 * Auth: cron-token (isCronAuthorized).
 */

import { isCronAuthorized } from '../../lib/cron-auth.js';
import { generateMarketingAdvice } from '../../lib/marketing-advisor.js';
import { sendGentsMail } from '../../lib/resend-mailer.js';

export const maxDuration = 120;

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function listHtml(arr) {
  if (!arr || !arr.length) return '<p style="color:#64748b;margin:4px 0">—</p>';
  return '<ul style="margin:6px 0 0;padding-left:18px">' + arr.map((x) => '<li style="margin-bottom:5px">' + esc(x) + '</li>').join('') + '</ul>';
}

function buildHtml(result) {
  const a = result.advice || {};
  const r = result.range || {};
  const cijfer = a.rapportcijfer;
  const col = cijfer == null ? '#64748b' : (Number(cijfer) >= 7 ? '#16a34a' : Number(cijfer) >= 5 ? '#d97706' : '#dc2626');
  const h = (t) => '<h3 style="margin:18px 0 4px;font-size:14px;color:#0f172a">' + t + '</h3>';
  const bench = (a.benchmark && a.benchmark.length)
    ? '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:6px"><thead><tr>'
      + ['Metric', 'GENTS', 'Benchmark', 'Oordeel'].map((c) => '<th style="text-align:left;border-bottom:1px solid #e2e8f0;padding:6px">' + c + '</th>').join('')
      + '</tr></thead><tbody>'
      + a.benchmark.map((b) => '<tr>'
        + '<td style="padding:6px;border-bottom:1px solid #f1f5f9">' + esc(b.metric) + '</td>'
        + '<td style="padding:6px;border-bottom:1px solid #f1f5f9"><strong>' + esc(b.gents) + '</strong></td>'
        + '<td style="padding:6px;border-bottom:1px solid #f1f5f9;color:#64748b">' + esc(b.benchmark) + '</td>'
        + '<td style="padding:6px;border-bottom:1px solid #f1f5f9">' + esc(b.oordeel) + '</td></tr>').join('')
      + '</tbody></table>'
    : '';
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#0f172a">
    <div style="background:#071B3A;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0">
      <div style="font-size:12px;opacity:.8;letter-spacing:.5px">GENTS &middot; MARKETING-ANALIST</div>
      <div style="font-size:19px;font-weight:700;margin-top:2px">Maandelijks marketing-advies</div>
      <div style="font-size:12px;opacity:.8;margin-top:2px">${esc(r.from)} t/m ${esc(r.to)}</div>
    </div>
    <div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:22px">
      <div style="display:flex;gap:16px;align-items:center;margin-bottom:10px">
        <div style="font-size:38px;font-weight:800;color:${col};line-height:1">${cijfer == null ? '&mdash;' : String(cijfer).replace('.', ',')}</div>
        <div style="font-size:12px;color:#64748b">bureau-cijfer /10</div>
      </div>
      <p style="font-size:14px;line-height:1.55;margin:0">${esc(a.oordeel || '')}</p>
      ${h('Sterke punten')}${listHtml(a.sterkePunten)}
      ${h('Zorgen')}${listHtml(a.zorgen)}
      ${h('Aanbevelingen')}${listHtml(a.aanbevelingen)}
      ${bench ? h('Benchmark vs. fashion e-commerce') + bench : ''}
      ${a.vragenVoorBureau && a.vragenVoorBureau.length ? h('Vragen voor het bureau') + listHtml(a.vragenVoorBureau) : ''}
      <p style="font-size:11px;color:#94a3b8;margin-top:20px;border-top:1px solid #f1f5f9;padding-top:10px">Automatisch gegenereerd door de GENTS Marketing-analist (AI). Controleer kritisch. Volledige data in het portaal &rarr; Marketing &rarr; Online.</p>
    </div>
  </div>`;
}

export default async function handler(req, res) {
  if (!isCronAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet geautoriseerd.' });
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const period = String(req.query.period || 'maand').toLowerCase();
  const dryRun = ['1', 'true', 'yes'].includes(String(req.query.dryRun || '').toLowerCase());
  const emailOverride = String(req.query.email || '').trim();
  const recipients = (emailOverride || process.env.MARKETING_ADVISOR_EMAIL || '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  try {
    const result = await generateMarketingAdvice(period);
    if (!result.ok) return res.status(200).json({ success: false, message: result.error });

    const cijfer = result.advice?.rapportcijfer;
    const subject = `Marketing-advies (${period}) — bureau-cijfer ${cijfer != null ? cijfer : '?'}/10`;

    if (!recipients.length) {
      return res.status(200).json({ success: true, skipped: true, message: 'Geen MARKETING_ADVISOR_EMAIL ingesteld — advies wel gegenereerd, niet gemaild.', cijfer });
    }
    if (dryRun) {
      return res.status(200).json({ success: true, dryRun: true, wouldSendTo: recipients, subject, cijfer });
    }

    await sendGentsMail({ to: recipients, subject, html: buildHtml(result), type: 'marketing-advies' });
    return res.status(200).json({ success: true, sent: recipients.length, period, cijfer });
  } catch (e) {
    console.error('[cron/marketing-advisor-mail]', e);
    return res.status(200).json({ success: false, message: e.message || 'Advies-mail mislukt.' });
  }
}
