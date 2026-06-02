/**
 * POST /api/admin/automation-ai   { prompt }
 *
 * Vertaalt een Nederlandse beschrijving naar een GESTRUCTUREERD automation-
 * voorstel (doelgroep-regel + mailtekst) via Claude. Slaat NIETS op en voert geen
 * code uit — geeft alleen een gevalideerd voorstel terug dat de gebruiker daarna
 * kan bekijken, aanpassen en opslaan.
 *
 * Auth: admin-token vereist.
 */

import { claudeMessage, getClaudeKey } from '../../lib/claude-client.js';
import { validateCustomRule, validateContent, describeRule, ruleNeedsTransactions } from '../../lib/custom-automations-store.js';
import { readProductsCache } from '../../lib/shopify-products-cache.js';
import { listBranchesFromConfig } from '../../lib/business-config.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

function extractJson(text) {
  let s = String(text || '').trim().replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/* Top-hoofdgroepen uit de productcache zodat de AI bestaande namen gebruikt. */
async function topHoofdgroepen(limit = 30) {
  try {
    const cache = await readProductsCache();
    const counts = new Map();
    for (const v of Object.values(cache.bySku || {})) {
      const hg = String(v.hoofdgroepOmschrijving || v.hoofdgroep || '').trim();
      if (hg) counts.set(hg, (counts.get(hg) || 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([k]) => k);
  } catch { return []; }
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (!getClaudeKey()) return res.status(503).json({ success: false, message: 'CLAUDE_API_KEY ontbreekt — AI-builder niet beschikbaar.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ success: false, message: 'Lege prompt.' });

    const [groepen, branches] = await Promise.all([topHoofdgroepen(), Promise.resolve(listBranchesFromConfig({ includeInternal: false }))]);
    const stores = branches.map((b) => b.store);

    const SYSTEM = `Je zet een Nederlandse beschrijving van een e-mail-automation om naar één JSON-object. Antwoord UITSLUITEND met geldige JSON, geen uitleg, geen markdown.

Schema:
{
  "label": "korte titel",
  "rule": {
    "lapsedMinDays": <getal of weglaten>,      // laatste aankoop minstens X dagen geleden
    "lapsedMaxDays": <getal of weglaten>,       // en hoogstens Y dagen geleden
    "boughtHoofdgroep": ["..."],                 // kocht eerder uit deze hoofdgroep(en); gebruik exact namen uit de lijst
    "registeredStores": ["..."],                 // alleen klanten ingeschreven in deze winkel(s); exact uit de lijst
    "birthdayWindowDays": <getal of weglaten>,   // binnen X dagen van de verjaardag (0 = op de dag)
    "minReceiptCount": <getal of weglaten>        // minimaal N aankopen
  },
  "content": {
    "subject": "onderwerp",
    "intro": "1-3 zinnen mailtekst, persoonlijk, NL",
    "buttonLabel": "knop-tekst",
    "buttonUrl": "https://gents.nl of specifieker",
    "voucherText": "optionele kortingstekst of leeg"
  }
}

Beschikbare hoofdgroepen: ${groepen.join(', ') || '(onbekend)'}.
Beschikbare winkels: ${stores.join(', ') || '(onbekend)'}.

Regels:
- "6 maanden niets gekocht" => lapsedMinDays 180. "tussen 6 en 18 maanden" => lapsedMinDays 180, lapsedMaxDays 540.
- "kocht eerder een pak/colbert" => boughtHoofdgroep met de best passende naam uit de lijst.
- "uit Den Haag" => registeredStores ["Den Haag"] (exact uit de lijst).
- "rond de verjaardag" => birthdayWindowDays 0 (of het genoemde aantal dagen).
- Laat velden die niet genoemd worden WEG (geen null).
- Verzin geen hoofdgroepen of winkels die niet in de lijsten staan.
- Schrijf een warme, korte Nederlandse intro en een passend onderwerp.`;

    const { text } = await claudeMessage({ system: SYSTEM, user: prompt, maxTokens: 600, temperature: 0.2 });
    let parsed;
    try { parsed = extractJson(text); }
    catch { return res.status(200).json({ success: false, message: 'Kon de prompt niet omzetten — formuleer iets concreter (bv. "klanten die 6 maanden geen pak kochten een reminder met 10% korting").', raw: text }); }

    const rule = validateCustomRule(parsed.rule || {});
    const content = validateContent(parsed.content || {});
    const label = String(parsed.label || 'Nieuwe automation').slice(0, 80);

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({
      success: true,
      draft: { label, rule, content },
      summary: describeRule(rule),
      needsTransactions: ruleNeedsTransactions(rule)
    });
  } catch (error) {
    console.error('[admin/automation-ai]', error);
    return res.status(500).json({ success: false, message: error.message || 'AI-builder mislukt.' });
  }
}
