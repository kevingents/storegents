/**
 * POST /api/admin/alert-rules-parse   { prompt }
 *
 * Vertaalt een natuurlijke-taal-prompt naar een GESTRUCTUREERDE alert-regel uit
 * de vaste whitelist (via Claude). Slaat NIETS op en voert geen code uit — geeft
 * alleen een gevalideerd voorstel terug dat de gebruiker daarna kan bevestigen.
 *
 * Auth: admin-token vereist.
 */

import { claudeMessage, getClaudeKey } from '../../lib/claude-client.js';
import { validateRule } from '../../lib/alert-rules-store.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 30;

const SYSTEM = `Je zet een Nederlandse beschrijving van een gewenste alert om naar één JSON-object. Antwoord UITSLUITEND met geldige JSON, geen uitleg, geen markdown.

Toegestane schema (kies precies één trigger-type):
{
  "naam": "korte titel",
  "trigger": {
    "type": "stock-threshold" | "schedule" | "event",
    // bij stock-threshold:
    "query": "<sku of artikelcode waar de gebruiker het over heeft>",
    "operator": "lte" | "lt" | "eq",   // 'op nul'/'leeg' => operator lte, waarde 0
    "waarde": <getal>,
    "scope": "magazijn" | "totaal",    // default totaal
    // bij schedule (terugkerende reminder):
    "freq": "daily" | "weekly" | "monthly",
    "weekday": 0-6,                     // 0=zondag..6=zaterdag (alleen weekly)
    "dayOfMonth": 1-28,                // alleen monthly
    "hour": 0-23,                       // default 8
    "bericht": "<reminder-tekst>",
    // bij event:
    "event": "online-zonder-foto" | "new-bol-order"
  },
  "actie": { "email": true, "notificatie": true }
}

Regels:
- "mail me als voorraad van X op 0/leeg komt" => stock-threshold, query=X, operator lte, waarde 0.
- "elke week reminder om de foto's te checken" => schedule, freq weekly, bericht="Foto's checken".
- "seintje als een artikel online komt zonder foto" => event, event=online-zonder-foto.
- "mail me bij een nieuwe bol bestelling" / "seintje bij een nieuwe bol order" => event, event=new-bol-order.
- Verzin geen andere trigger-types of events. Twijfel je over de query/artikel: neem letterlijk over wat de gebruiker noemt.`;

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
  if (!getClaudeKey()) return res.status(503).json({ success: false, message: 'CLAUDE_API_KEY ontbreekt — AI-parsing niet beschikbaar.' });

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ success: false, message: 'Lege prompt.' });

    const { text } = await claudeMessage({ system: SYSTEM, user: prompt, maxTokens: 400, temperature: 0 });
    let parsed;
    try { parsed = extractJson(text); }
    catch { return res.status(200).json({ success: false, message: 'Kon de prompt niet omzetten — formuleer iets concreter (bv. "mail me als voorraad van 2900003621166 op 0 komt").', raw: text }); }

    const v = validateRule(parsed);
    if (!v.ok) return res.status(200).json({ success: false, message: v.error, parsed });

    res.setHeader('Cache-Control', 'no-store, max-age=0');
    return res.status(200).json({ success: true, rule: v.rule });
  } catch (error) {
    console.error('[admin/alert-rules-parse]', error);
    return res.status(500).json({ success: false, message: error.message || 'Parsing mislukt.' });
  }
}
