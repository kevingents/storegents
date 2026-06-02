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
import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

const ALLOWED = ['brandName', 'headerBg', 'buttonBg', 'textColor', 'pageBg', 'logoUrl', 'greetingPrefix', 'signoff', 'footerText', 'buttonLabel', 'shopUrl'];
const ENUMS = { buttonStyle: ['filled', 'outline'], headingFont: ['serif', 'sans'], contentAlign: ['left', 'center'] };

function parseBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body || '{}'); } catch { return {}; }
}

function sanitizeTheme(input = {}) {
  const out = {};
  for (const k of ALLOWED) if (input[k] != null) out[k] = String(input[k]).slice(0, 400);
  for (const [k, vals] of Object.entries(ENUMS)) if (input[k] != null && vals.includes(String(input[k]))) out[k] = String(input[k]);
  if (input.buttonRadius != null) { const n = Math.round(Number(input.buttonRadius)); if (Number.isFinite(n)) out.buttonRadius = Math.max(0, Math.min(28, n)); }
  return out;
}

/* Echte productbeelden uit de cache (kloppende preview i.p.v. placeholder). */
async function sampleProducts(n = 2) {
  try {
    const cache = await readProductsCache();
    const seen = new Set(); const out = [];
    for (const v of Object.values(cache.bySku || {})) {
      if (!v || !v.image || !v.productUrl || seen.has(v.productUrl)) continue;
      seen.add(v.productUrl);
      out.push({ title: v.title || 'Item', image: v.image, url: v.productUrl, matchedSizes: v.size ? [String(v.size)] : [] });
      if (out.length >= n) break;
    }
    return out;
  } catch { return []; }
}

/* Representatief voorbeeld: groet + intro + 2 productkaarten + cadeau-box + knop. */
async function previewHtml(theme) {
  let sample = await sampleProducts(2);
  if (!sample.length) sample = [
    { title: 'Colbert blend navy', image: '', url: '#', matchedSizes: ['50', '52'] },
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
      return res.status(200).json({ success: true, html: await previewHtml(theme) });
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
