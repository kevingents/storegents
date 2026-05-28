/**
 * Dunne client voor de Anthropic (Claude) Messages API met automatische
 * model-detectie.
 *
 * Sleutel: process.env.CLAUDE_API_KEY (fallback ANTHROPIC_API_KEY).
 * Model:   process.env.CLAUDE_MODEL (optioneel). Werkt dat model niet, dan
 *          vraagt de client via /v1/models op welke modellen de key toegang
 *          heeft en kiest automatisch het beste (voorkeur: Sonnet). Geen
 *          env-var nodig om aan de praat te komen.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100';
const VERSION = '2023-06-01';
/* Laatste fallbacks als /v1/models niet bereikbaar is. */
const FALLBACK_MODELS = ['claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219', 'claude-3-5-haiku-20241022'];

let __workingModel = ''; /* in-memory cache van een model dat wél werkt */

export function getClaudeKey() {
  return String(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
}

export function getClaudeModel() {
  return String(process.env.CLAUDE_MODEL || '').trim() || __workingModel || FALLBACK_MODELS[0];
}

async function listAvailableModels(key) {
  try {
    const r = await fetch(MODELS_URL, { headers: { 'x-api-key': key, 'anthropic-version': VERSION } });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.data || []).map((m) => m && m.id).filter(Boolean);
  } catch { return []; }
}

/* Beste model uit een lijst: voorkeur Sonnet → Haiku → eerste. /v1/models is
   nieuw-eerst gesorteerd, dus de eerste Sonnet is de nieuwste. */
function pickBest(ids) {
  return ids.find((id) => /sonnet/i.test(id)) || ids.find((id) => /haiku/i.test(id)) || ids[0] || '';
}

async function callModel(key, model, body) {
  const resp = await fetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, model })
  });
  const data = await resp.json().catch(() => ({}));
  return { resp, data };
}

/* Probeert het verzoek tegen een reeks modellen tot er één werkt; retourneert
   { text, model }. `body` is het volledige Messages-API-verzoek zonder `model`. */
async function runCompletion(key, body, model) {
  const tried = [];
  let lastMsg = 'Claude-aanroep mislukt';

  const attempt = async (m) => {
    if (!m || tried.includes(m)) return null;
    tried.push(m);
    let r;
    try { r = await callModel(key, m, body); }
    catch (e) { throw new Error(`Kon Claude niet bereiken: ${e.message}`); }
    if (r.resp.ok) {
      const text = Array.isArray(r.data?.content)
        ? r.data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim()
        : '';
      if (!text) throw new Error('Claude gaf geen tekst terug.');
      __workingModel = r.data.model || m;
      return { text, model: __workingModel };
    }
    lastMsg = r.data?.error?.message || `Claude API fout ${r.resp.status}`;
    const modelIssue = r.resp.status === 404 || /model|not[_ ]?found|does not exist|permission|toegang/i.test(lastMsg);
    if (!modelIssue) throw new Error(lastMsg); /* echte fout (auth/rate/validatie) */
    return null;
  };

  /* 1) Eerder werkend model + expliciet/env-model. */
  for (const m of [__workingModel, model, String(process.env.CLAUDE_MODEL || '').trim()]) {
    const res = await attempt(m);
    if (res) return res;
  }

  /* 2) Vraag op welke modellen de key toegang heeft en pak de beste. */
  const available = await listAvailableModels(key);
  const res = await attempt(pickBest(available.filter((id) => !tried.includes(id))));
  if (res) return res;

  /* 3) Harde fallbacks (mocht /v1/models niet bereikbaar zijn). */
  for (const m of FALLBACK_MODELS) {
    const r2 = await attempt(m);
    if (r2) return r2;
  }

  throw new Error(`${lastMsg}.${available.length ? ` Beschikbaar voor deze key: ${available.slice(0, 8).join(', ')}` : ' Geen modellen beschikbaar voor deze key — controleer het Anthropic-account/credits.'}`);
}

/**
 * Eén turn naar Claude (alleen tekst). Retourneert { text, model }.
 */
export async function claudeMessage({ system, user, maxTokens = 600, temperature = 0.7, model } = {}) {
  const key = getClaudeKey();
  if (!key) throw new Error('CLAUDE_API_KEY ontbreekt in de Vercel-omgeving.');
  if (!user) throw new Error('Lege prompt.');

  return runCompletion(key, {
    max_tokens: maxTokens,
    temperature,
    system: system || undefined,
    messages: [{ role: 'user', content: String(user) }]
  }, model);
}

/**
 * Beeldherkenning: stuurt één of meer afbeeldings-URL's mét een tekstprompt naar
 * Claude vision. Retourneert { text, model }. Max 8 afbeeldingen per aanroep.
 */
export async function claudeVision({ system, user, imageUrls = [], maxTokens = 300, temperature = 0, model } = {}) {
  const key = getClaudeKey();
  if (!key) throw new Error('CLAUDE_API_KEY ontbreekt in de Vercel-omgeving.');
  const urls = (Array.isArray(imageUrls) ? imageUrls : [])
    .map((u) => String(u == null ? '' : u).trim())
    .filter(Boolean)
    .slice(0, 8);
  if (!urls.length) throw new Error('Geen afbeeldingen om te analyseren.');

  const content = [
    ...urls.map((url) => ({ type: 'image', source: { type: 'url', url } })),
    { type: 'text', text: String(user || 'Beschrijf deze afbeeldingen.') }
  ];

  return runCompletion(key, {
    max_tokens: maxTokens,
    temperature,
    system: system || undefined,
    messages: [{ role: 'user', content }]
  }, model);
}
