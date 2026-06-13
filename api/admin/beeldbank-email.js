import { handleCors, setCorsHeaders } from '../../lib/cors.js';
import { buildImageZip } from '../../lib/beeldbank-zip.js';
import { sendGentsMail } from '../../lib/resend-mailer.js';

/**
 * POST /api/admin/beeldbank-email
 *   { to, filename, images:[url], productTitle, productUrl, note, actorName }
 * Bouwt de ZIP, zet 'm in Blob en mailt de ontvanger een download-link.
 * (Link i.p.v. bijlage = robuust, geen mail-groottelimieten.)
 */

export const config = { maxDuration: 60 };

function clean(v) { return String(v == null ? '' : v).trim(); }
function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
const isEmail = (s) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(s || '').trim());

function isAuthorized(req) {
  const adminToken = clean(process.env.ADMIN_TOKEN);
  if (!adminToken) return false;
  const token = clean(
    req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization ||
    req.query?.adminToken || req.query?.admin_token || ''
  ).replace(/^Bearer\s+/i, '');
  return token === adminToken;
}

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!isAuthorized(req)) return res.status(401).json({ success: false, message: 'Niet bevoegd.' });

  const body = parseBody(req);
  const to = clean(body.to);
  const images = Array.isArray(body.images) ? body.images : [];
  const title = clean(body.productTitle) || 'Productbeelden';
  const productUrl = clean(body.productUrl);
  const note = clean(body.note);
  const actor = clean(body.actorName) || 'GENTS';

  if (!isEmail(to)) return res.status(400).json({ success: false, message: 'Geef een geldig e-mailadres.' });
  if (!images.length) return res.status(400).json({ success: false, message: 'Geen afbeeldingen meegegeven.' });

  try {
    const zip = await buildImageZip({ filename: title, images });
    const mb = (zip.bytes / 1048576).toFixed(1);
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#0a1f33">
      <h2 style="margin:0 0 12px;font-size:18px">${esc(title)} — productbeelden</h2>
      <p style="margin:0 0 8px">${esc(actor)} deelt ${zip.count} foto${zip.count === 1 ? '' : "'s"} met je als ZIP.</p>
      ${note ? `<p style="margin:0 0 12px;color:#475569">${esc(note)}</p>` : ''}
      <p style="margin:16px 0">
        <a href="${esc(zip.url)}" style="background:#0a1f33;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">
          Download ZIP (${zip.count} foto's · ${mb} MB)
        </a>
      </p>
      ${productUrl ? `<p style="margin:0;color:#475569;font-size:12px">Product: <a href="${esc(productUrl)}">${esc(productUrl)}</a></p>` : ''}
      <p style="margin:16px 0 0;color:#94a3b8;font-size:12px">Link blijft een tijd geldig. Verzonden vanuit het GENTS-portaal.</p>
    </div>`;

    await sendGentsMail({
      to,
      subject: `Productbeelden: ${title}`,
      html,
      type: 'beeldbank',
      replyTo: clean(body.replyTo) || undefined,
      meta: { productUrl, count: zip.count },
    });

    return res.status(200).json({ success: true, to, count: zip.count, url: zip.url });
  } catch (error) {
    console.error('[admin/beeldbank-email]', error);
    return res.status(200).json({ success: false, message: error.message || 'Mailen mislukt.' });
  }
}
