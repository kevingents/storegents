/**
 * lib/gala-crawl.js
 *
 * Dagelijkse "crawl" voor gala-/lustrum-datums van studentenverenigingen.
 * Haalt een set bronnen op (Reddit-zoek-JSON + agenda/lustrum-pagina's), laat
 * Claude er evenementen-met-datum uit halen, en levert die als kandidaten
 * ('vermoedelijk', te verifiëren) terug. Geen scraping van afgeschermde/login-
 * content — alleen publieke pagina's. Best-effort: faalt een bron, dan door.
 */

import { claudeMessage, getClaudeKey } from './claude-client.js';

export const DEFAULT_SOURCES = [
  /* Reddit — publieke JSON-API, NL + BE kerntermen (gala / galabal / lustrum / almanakbal) */
  { url: 'https://www.reddit.com/search.json?q=studentenvereniging%20gala&sort=new&limit=25', kind: 'reddit' },
  { url: 'https://www.reddit.com/search.json?q=lustrum%20gala&sort=new&limit=25', kind: 'reddit' },
  { url: 'https://www.reddit.com/search.json?q=lustrumgala&sort=new&limit=25', kind: 'reddit' },
  { url: 'https://www.reddit.com/search.json?q=galabal&sort=new&limit=25', kind: 'reddit' },
  { url: 'https://www.reddit.com/search.json?q=studentengala&sort=new&limit=25', kind: 'reddit' },
  { url: 'https://www.reddit.com/search.json?q=almanakbal&sort=new&limit=25', kind: 'reddit' },
  /* NL — studentenstad-agenda's + vaste gala/lustrum-pagina's (server-side HTML, titel+datum) */
  { url: 'https://studentenstadwageningen.nl/ontdek-wageningen/open-feesten-agenda', kind: 'html' },
  { url: 'https://studentenstadleiden.nl/agenda.html', kind: 'html' },
  { url: 'https://amsterdamschgalabal.nl/en/amsterdam-ball/', kind: 'html' },
  { url: 'https://www.lustrumusc.nl/evenementen', kind: 'html' },
  { url: 'https://www.lustrum.usr.nl', kind: 'html' },
  { url: 'https://kleio-amsterdam.nl/lustrum-gala/', kind: 'html' },
  /* BE — universiteits-/koepel-agenda's + vaste galabal-pagina's (Antwerpen/Gent/Leuven) */
  { url: 'https://www.uantwerpen.be/nl/studentenleven/vrije-tijd/studentenverenigingen/studentenevents/', kind: 'html' },
  { url: 'https://dsa.ugent.be/activiteiten', kind: 'html' },
  { url: 'https://www.politeia-gent.be/galabal', kind: 'html' },
  { url: 'https://www.medica.be/kalender', kind: 'html' },
  { url: 'https://www.galabal.be/', kind: 'html' }
];

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchSource(src, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(src.url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'GENTS-portal-gala-crawler/1.0 (+marketing research)', Accept: src.kind === 'reddit' ? 'application/json' : 'text/html' }
    });
    if (!res.ok) return { url: src.url, ok: false, text: '' };
    if (src.kind === 'reddit') {
      const j = await res.json().catch(() => null);
      const posts = ((j && j.data && j.data.children) || []).map((c) => {
        const d = c.data || {};
        return (d.title || '') + ' — ' + String(d.selftext || '').slice(0, 200) + ' [r/' + (d.subreddit || '') + ', https://reddit.com' + (d.permalink || '') + ']';
      });
      return { url: src.url, ok: true, text: posts.join('\n').slice(0, 4000) };
    }
    const html = await res.text();
    return { url: src.url, ok: true, text: stripHtml(html).slice(0, 5000) };
  } catch (e) {
    return { url: src.url, ok: false, text: '', error: e.message };
  } finally { clearTimeout(t); }
}

export async function crawlGala({ sources = DEFAULT_SOURCES } = {}) {
  if (!getClaudeKey()) return { events: [], checked: [], error: 'Geen Claude API-key (CLAUDE_API_KEY) in Vercel.' };

  /* Parallel ophalen: aparte domeinen, dus geen rate-limit, en de wandkloktijd
     blijft ~= de traagste fetch (12s) i.p.v. de som — nodig nu de bronnenlijst
     groter is, ruim binnen maxDuration (90s). */
  const results = await Promise.all(sources.map((s) => fetchSource(s)));
  const checked = results.map((r) => ({ url: r.url, ok: r.ok }));
  const corpus = results.filter((r) => r.ok && r.text).map((r) => '### BRON: ' + r.url + '\n' + r.text).join('\n\n').slice(0, 38000);
  if (!corpus) return { events: [], checked, error: 'Geen bronnen bereikbaar.' };

  const today = new Date().toISOString().slice(0, 10);
  const system = 'Je bent een research-assistent voor een Nederlandse herenmode-keten (smokings/pakken). Je extraheert UITSLUITEND gala-, lustrum-, diës- en galabal-evenementen van Nederlandse of Belgische studentenverenigingen waarvoor een EXPLICIETE kalenderdatum letterlijk in de aangeleverde tekst staat. Verzin niets en gok geen datums. Geen expliciete datum in de tekst = niet opnemen.';
  const user = 'Vandaag is ' + today + '. Hieronder ruwe tekst van meerdere publieke bronnen. Geef UITSLUITEND een JSON-array terug (geen uitleg) met evenementen met een datum tussen vandaag en 14 maanden vooruit. Elk item exact: {"title","association","city","date","source","notes"} waarbij date = "YYYY-MM-DD" en source = de bron-URL/permalink waar je het vond. Alleen items met een echte datum in de tekst. Niets gevonden → [].\n\n' + corpus;

  let parsed = [];
  try {
    const resp = await claudeMessage({ system, user, maxTokens: 2200, temperature: 0 });
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
    notes: ('Automatisch gevonden (crawl ' + today + ') — verifiëren. ' + String(e.notes || '')).trim()
  })).filter((e) => e.title && /^\d{4}-\d{2}-\d{2}$/.test(e.date) && e.date >= today);

  return { events, checked };
}
