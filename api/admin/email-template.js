/**
 * /api/admin/email-template
 *
 * Bewerkbaar e-mail-thema (uiterlijk van alle nieuwsbrieven/automations).
 *
 * GET                    → { theme, defaults }
 * POST ?action=save      { theme }              → opslaan
 *      ?action=preview   { theme }              → gerenderde voorbeeld-HTML (niet opgeslagen)
 *
 * Auth: admin-token vereist.
 */

import { getEmailTheme, saveEmailTheme, EMAIL_THEME_DEFAULTS } from '../../lib/email-template-store.js';
import { emailShell, productCard, ctaButton, voucherBox } from '../../lib/automations-core.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

const ALLOWED = ['brandName', 'headerBg', 'buttonBg', 'textColor', 'pageBg', 'logoUrl', 'greetingPrefix', 'signoff', 'footerText', 'buttonLabel', 'shopUrl'];

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function sanitizeTheme(input = {}) {
  const out = {};
  for (const k of ALLOWED) if (input[k] != null) out[k] = String(input[k]).slice(0, 400);
  return out;
}

/* Representatief voorbeeld: groet + intro + 2 productkaarten + cadeau-box + knop. */
function previewHtml(theme) {
  const sample = [
    { title: 'Colbert blend navy', image: 'https://cdn.shopify.com/s/files/1/placeholder.png', url: '#', matchedSizes: ['50', '52'] },
    { title: 'Pantalon wol grijs', image: '', url: '#', matchedSizes: ['33'] }
  ];
  const body = `<p style="margin:0 0 16px">Er is nieuwe collectie binnen die past bij wat je eerder bij ons koos — en we hebben jouw maat nog op voorraad:</p>`
    + sample.map((p) => productCard(p, theme)).join('')
    + voucherBox('Met je verjaardag: 10% met code BDAY10 deze maand.', theme)
    + `<p style="margin:14px 0 0">${ctaButton('', '', theme)}</p>`;
  return emailShell({ store: 'Den Haag', firstName: 'Jan', theme, bodyHtml: body, footer: '<a href="#" style="color:#999">Afmelden</a>.' });
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ success: true, theme: await getEmailTheme(), defaults: EMAIL_THEME_DEFAULTS });
    }

    const action = String(req.query?.action || '').trim();
    const body = parseBody(req);

    if (action === 'preview') {
      const theme = { ...(await getEmailTheme()), ...sanitizeTheme(body.theme || {}) };
      return res.status(200).json({ success: true, html: previewHtml(theme) });
    }
    if (action === 'save') {
      const theme = await saveEmailTheme(sanitizeTheme(body.theme || {}));
      return res.status(200).json({ success: true, theme });
    }
    return res.status(400).json({ success: false, message: 'Onbekende actie.' });
  } catch (e) {
    console.error('[admin/email-template]', e);
    return res.status(500).json({ success: false, message: e.message || 'Template-actie mislukt.' });
  }
}
