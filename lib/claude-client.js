/**
 * Dunne client voor de Anthropic (Claude) Messages API.
 *
 * Sleutel: process.env.CLAUDE_API_KEY (fallback ANTHROPIC_API_KEY).
 * Model:   process.env.CLAUDE_MODEL (optioneel). Als dat model niet beschikbaar
 *          is voor de key, valt de client automatisch terug op de volgende uit
 *          FALLBACK_MODELS — geen env-var nodig om aan de praat te komen.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
/* Breed-beschikbaar default; fallbacks dekken nieuwere/oudere keys af. */
const DEFAULT_MODEL = 'claude-3-5-sonnet-20241022';
const FALLBACK_MODELS = [
  'claude-3-7-sonnet-20250219',
  'claude-3-5-sonnet-20241022',
  'claude-3-5-haiku-20241022'
];

export function getClaudeKey() {
  return String(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
}

export function getClaudeModel() {
  return String(process.env.CLAUDE_MODEL || '').trim() || DEFAULT_MODEL;
}

function candidateModels(explicit) {
  const env = String(process.env.CLAUDE_MODEL || '').trim();
  return [...new Set([explicit, env, DEFAULT_MODEL, ...FALLBACK_MODELS].filter(Boolean))];
}

/**
 * Eén turn naar Claude, met automatische model-fallback.
 * Retourneert { text, model }.
 */
export async function claudeMessage({ system, user, maxTokens = 600, temperature = 0.7, model } = {}) {
  const key = getClaudeKey();
  if (!key) throw new Error('CLAUDE_API_KEY ontbreekt in de Vercel-omgeving.');
  if (!user) throw new Error('Lege prompt.');

  const candidates = candidateModels(model);
  let lastMsg = 'Claude-aanroep mislukt';

  for (const m of candidates) {
    let resp;
    try {
      resp = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: m,
          max_tokens: maxTokens,
          temperature,
          system: system || undefined,
          messages: [{ role: 'user', content: String(user) }]
        })
      });
    } catch (e) {
      throw new Error(`Kon Claude niet bereiken: ${e.message}`);
    }

    const data = await resp.json().catch(() => ({}));
    if (resp.ok) {
      const text = Array.isArray(data?.content)
        ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim()
        : '';
      if (!text) throw new Error('Claude gaf geen tekst terug.');
      return { text, model: data.model || m };
    }

    lastMsg = data?.error?.message || `Claude API fout ${resp.status}`;
    const modelIssue = resp.status === 404 || /model|not[_ ]?found|does not exist|permission|toegang/i.test(lastMsg);
    if (!modelIssue) break; /* echte fout (auth/rate/validatie) → niet verder proberen */
  }

  throw new Error(`${lastMsg} (modellen geprobeerd: ${candidates.join(', ')})`);
}
