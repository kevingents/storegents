/**
 * Dunne client voor de Anthropic (Claude) Messages API.
 *
 * Sleutel: process.env.CLAUDE_API_KEY (fallback ANTHROPIC_API_KEY).
 * Model:   process.env.CLAUDE_MODEL (default hieronder) — pas dit env-var aan
 *          als het defaultmodel niet (meer) beschikbaar is voor de key.
 */

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const DEFAULT_MODEL = 'claude-sonnet-4-20250514';

export function getClaudeKey() {
  return String(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY || '').trim();
}

export function getClaudeModel() {
  return String(process.env.CLAUDE_MODEL || '').trim() || DEFAULT_MODEL;
}

/**
 * Eén turn naar Claude. Retourneert { text, model }.
 */
export async function claudeMessage({ system, user, maxTokens = 600, temperature = 0.7, model } = {}) {
  const key = getClaudeKey();
  if (!key) throw new Error('CLAUDE_API_KEY ontbreekt in de Vercel-omgeving.');
  if (!user) throw new Error('Lege prompt.');

  const useModel = model || getClaudeModel();
  let resp;
  try {
    resp = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: useModel,
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
  if (!resp.ok) {
    const msg = data?.error?.message || `Claude API fout ${resp.status}`;
    throw new Error(`${msg}${/model/i.test(msg) ? ' (stel evt. CLAUDE_MODEL in)' : ''}`);
  }

  const text = Array.isArray(data?.content)
    ? data.content.filter((b) => b && b.type === 'text').map((b) => b.text).join('').trim()
    : '';
  if (!text) throw new Error('Claude gaf geen tekst terug.');
  return { text, model: data.model || useModel };
}
