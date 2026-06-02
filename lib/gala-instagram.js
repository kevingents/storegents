/**
 * lib/gala-instagram.js
 *
 * Haalt publieke Instagram-posts van studentenverenigingen op via de Instagram
 * Graph API ("business discovery") en laat Claude er gala-/galabal-datums uit
 * halen. Alleen PUBLIEKE business/creator-accounts zijn zo leesbaar — privé- of
 * persoonlijke accounts niet (dat is precies wat de gewone crawler ook niet kan).
 *
 * Wat waar hoort (conform projectregels):
 *  - SECRET in Vercel env: het Graph-token + je eigen IG-business-id.
 *      INSTAGRAM_GRAPH_TOKEN  (of IG_GRAPH_TOKEN / FB_GRAPH_TOKEN)
 *      INSTAGRAM_BUSINESS_ID  (of IG_BUSINESS_ID)
 *  - CONFIG in de tool (blob via portal-config → Instellingen): de lijst
 *      usernames die we volgen (gala.instagramAccounts).
 *
 * Zonder token/id geeft de lib een nette melding terug i.p.v. te crashen, zodat
 * de feature "klaarstaat" en live gaat zodra het token in Vercel staat.
 */

import { claudeMessage, getClaudeKey } from './claude-client.js';

const GRAPH_VERSION = 'v21.0';

export function getInstagramToken() {
  return String(process.env.INSTAGRAM_GRAPH_TOKEN || process.env.IG_GRAPH_TOKEN || process.env.FB_GRAPH_TOKEN || '').trim();
}
export function getInstagramBusinessId() {
  return String(process.env.INSTAGRAM_BUSINESS_ID || process.env.IG_BUSINESS_ID || '').trim();
}

/** Business-discovery: recente media (caption + permalink + timestamp) van één publiek account. */
async function fetchAccountMedia({ bizId, token, username, limit = 12, timeoutMs = 12000 }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const fields = `business_discovery.username(${encodeURIComponent(username)}){username,media.limit(${limit}){caption,permalink,timestamp}}`;
    const url = `https://graph.facebook.com/${GRAPH_VERSION}/${encodeURIComponent(bizId)}?fields=${fields}&access_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: ctrl.signal });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || j.error) {
      return { username, ok: false, error: (j && j.error && j.error.message) || ('HTTP ' + res.status), posts: [] };
    }
    const media = ((j.business_discovery && j.business_discovery.media && j.business_discovery.media.data) || []);
    const posts = media
      .filter((m) => m && m.caption)
      .map((m) => ({ caption: String(m.caption).slice(0, 400), permalink: m.permalink || '', timestamp: m.timestamp || '' }));
    return { username, ok: true, posts };
  } catch (e) {
    return { username, ok: false, error: e.message, posts: [] };
  } finally { clearTimeout(t); }
}

/**
 * Haal van alle opgegeven accounts de recente posts op en laat Claude er
 * gala-evenementen met datum uit halen. Retourneert events als 'vermoedelijk'.
 */
export async function crawlInstagramGala({ accounts = [] } = {}) {
  const token = getInstagramToken();
  const bizId = getInstagramBusinessId();
  if (!token || !bizId) {
    return { events: [], checked: [], error: 'Geen Instagram-token/-business-id in Vercel (INSTAGRAM_GRAPH_TOKEN + INSTAGRAM_BUSINESS_ID).' };
  }
  if (!getClaudeKey()) return { events: [], checked: [], error: 'Geen Claude API-key (CLAUDE_API_KEY) in Vercel.' };
  const list = (accounts || []).map((s) => String(s || '').trim()).filter(Boolean);
  if (!list.length) return { events: [], checked: [], error: 'Geen Instagram-accounts ingesteld (Instellingen → Gala-Instagram).' };

  const results = await Promise.all(list.map((u) => fetchAccountMedia({ bizId, token, username: u })));
  const checked = results.map((r) => ({ username: r.username, ok: r.ok, posts: r.posts.length, error: r.error || null }));

  const blocks = [];
  for (const r of results) {
    if (!r.ok || !r.posts.length) continue;
    const lines = r.posts.map((p) => '- ' + p.caption.replace(/\s+/g, ' ') + ' [' + (p.permalink || ('@' + r.username)) + ']');
    blocks.push('### @' + r.username + '\n' + lines.join('\n'));
  }
  const corpus = blocks.join('\n\n').slice(0, 30000);
  if (!corpus) {
    const anyErr = checked.find((c) => c.error);
    return { events: [], checked, error: anyErr ? ('Geen posts leesbaar — ' + anyErr.error) : 'Geen posts met tekst gevonden.' };
  }

  const today = new Date().toISOString().slice(0, 10);
  const system = 'Je bent een research-assistent voor een Nederlandse herenmode-keten (smokings/pakken). Je extraheert UITSLUITEND gala-, lustrum-, diës- en galabal-evenementen van studentenverenigingen uit Instagram-bijschriften, en alleen als er een EXPLICIETE kalenderdatum letterlijk in de tekst staat. Verzin niets en gok geen datums.';
  const user = 'Vandaag is ' + today + '. Hieronder Instagram-bijschriften per account. Geef UITSLUITEND een JSON-array terug (geen uitleg) met evenementen met een datum tussen vandaag en 14 maanden vooruit. Elk item exact: {"title","association","city","date","source","notes"} waarbij date="YYYY-MM-DD" en source=de permalink uit de blokhaken. Alleen items met een echte datum in de tekst. Niets gevonden → [].\n\n' + corpus;

  let parsed = [];
  try {
    const resp = await claudeMessage({ system, user, maxTokens: 1800, temperature: 0 });
    const m = String((resp && resp.text) || '').match(/\[[\s\S]*\]/);
    parsed = m ? JSON.parse(m[0]) : [];
  } catch (e) {
    return { events: [], checked, error: 'Claude-extractie faalde: ' + e.message };
  }

  const events = (Array.isArray(parsed) ? parsed : []).map((e) => ({
    title: String(e.title || '').trim(),
    association: String(e.association || '').trim(),
    city: String(e.city || '').trim(),
    date: String(e.date || '').slice(0, 10),
    source: String(e.source || '').trim(),
    status: 'vermoedelijk',
    type: 'gala',
    notes: ('Gevonden via Instagram (' + today + ') — verifiëren. ' + String(e.notes || '')).trim()
  })).filter((e) => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= today);

  return { events, checked };
}
