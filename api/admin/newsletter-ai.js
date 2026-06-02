/**
 * POST /api/admin/newsletter-ai   { doel, thema, tone, type }
 *
 * Genereert Nederlandse nieuwsbrief-copy voor GENTS (onderwerp, preview-tekst,
 * intro, producttekst, CTA) via Claude. type='all' → alles; anders één veld.
 * Slaat niets op — geeft alleen tekst terug die de gebruiker kan plakken.
 *
 * Auth: admin-token vereist.
 */

import { claudeMessage, getClaudeKey } from '../../lib/claude-client.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

const FIELDS = ['subject', 'preview', 'intro', 'productText', 'cta'];
const clean = (v) => String(v == null ? '' : v).trim();

function extractJson(text) {
  let s = String(text || '').trim().replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!getClaudeKey()) return res.status(503).json({ success: false, message: 'CLAUDE_API_KEY ontbreekt — AI-generator niet beschikbaar.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const doel = clean(body.doel) || 'Verkoop';
    const thema = clean(body.thema) || 'algemene nieuwsbrief';
    const tone = clean(body.tone) || 'Inspirerend';
    const type = FIELDS.includes(clean(body.type)) ? clean(body.type) : 'all';

    const SYSTEM = `Je bent copywriter voor GENTS Herenmode (pakken, colberts, kostuums, accessoires; stijlvol, verzorgd, mannelijk). Schrijf Nederlandse nieuwsbrief-copy. Antwoord UITSLUITEND met geldige JSON, geen uitleg of markdown.

Velden (vul ${type === 'all' ? 'ALLE' : 'alleen het veld "' + type + '"'}):
{
  "subject": "onderwerp, pakkend, max 55 tekens, geen overdreven clickbait of uitroeptekens-spam",
  "preview": "preheader-tekst, max 90 tekens, vult het onderwerp aan",
  "intro": "2-3 warme zinnen die bij het merk passen",
  "productText": "1-2 zinnen wervende producttekst",
  "cta": "korte knop-tekst, max 22 tekens"
}

Context — Doel: ${doel}. Collectie/thema: ${thema}. Tone of voice: ${tone}.
Schrijf in het Nederlands, je-vorm, kwaliteit van een goed modemerk.`;

    const user = type === 'all' ? 'Genereer alle velden.' : `Genereer alleen het veld "${type}".`;
    const { text } = await claudeMessage({ system: SYSTEM, user, maxTokens: 700, temperature: 0.7 });

    let parsed;
    try { parsed = extractJson(text); }
    catch { return res.status(200).json({ success: false, message: 'Kon de AI-tekst niet verwerken — probeer opnieuw of vul een concreter thema in.', raw: text }); }

    const out = {};
    for (const f of FIELDS) if (parsed[f] != null) out[f] = clean(parsed[f]).slice(0, f === 'intro' || f === 'productText' ? 600 : 160);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, fields: out, doel, thema, tone, type });
  } catch (error) {
    console.error('[admin/newsletter-ai]', error);
    return res.status(500).json({ success: false, message: error.message || 'AI-generator mislukt.' });
  }
}
