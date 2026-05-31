/**
 * lib/hq-bot.js
 *
 * GENTS HQ-bot: een Claude-assistent over de portal-data. Veilig:
 *  - Claude mag ALLEEN een vaste set READ-ONLY tools aanroepen (geen code).
 *  - De toegang wordt server-side bepaald via de ROL van de gebruiker
 *    (getUserPermissions) — niet via de prompt. HQ-rollen zien alle winkels;
 *    winkel-rollen alleen hun eigen winkel(s), hard gefilterd in elke tool.
 *
 * Flow (2 stappen, geen native tool-use nodig):
 *   1) Claude kiest welke tools nodig zijn → JSON {calls:[{tool,args}]}.
 *   2) Backend voert de toegestane tools permissie-gescoped uit.
 *   3) Claude beantwoordt de vraag uitsluitend op basis van die data.
 */

import { claudeMessage, getClaudeKey } from './claude-client.js';
import { getUserPermissions } from './user-permissions-store.js';
import { readLedger, aggregateLedger, periodToRange } from './srs-retail-ledger.js';
import { readVoorraadRows } from './srs-voorraad-store.js';
import { readProductAudit } from './shopify-product-audit.js';

const HQ_ROLES = new Set(['admin', 'office', 'finance', 'regio_manager']);

async function resolveTier(personnelId) {
  if (!personnelId) return { tier: 'store', role: 'onbekend' };
  try {
    const p = await getUserPermissions(String(personnelId));
    const role = (p && p.role) || 'medewerker';
    return { tier: HQ_ROLES.has(role) ? 'hq' : 'store', role };
  } catch { return { tier: 'store', role: 'onbekend' }; }
}

/* Read-only tool-registry. Elke tool: tiers (wie mag), desc, args (voor de plan-prompt), handler. */
const TOOLS = [
  {
    id: 'winkelomzet', tiers: ['hq'],
    desc: 'Omzet + bonnen per winkel voor een periode (winkel-kassa, uit de SFTP-ledger).',
    args: { period: 'vandaag|gisteren|week|maand|kwartaal|jaar' },
    handler: async (args) => {
      const period = ['vandaag', 'gisteren', 'week', 'maand', 'kwartaal', 'jaar'].includes(args.period) ? args.period : 'maand';
      const agg = aggregateLedger(await readLedger(), periodToRange(period));
      return {
        periode: period,
        totaalOmzet: agg.totals?.omzet, totaalBonnen: agg.totals?.bonnen,
        winkels: (agg.filialen || []).slice(0, 30).map((f) => ({ winkel: f.store, omzet: f.omzet, bonnen: f.bonnen }))
      };
    }
  },
  {
    id: 'voorraad_zoek', tiers: ['hq', 'store'],
    desc: 'Zoek de voorraad per winkel voor een SKU/artikelcode.',
    args: { query: 'sku of artikelcode' },
    handler: async (args, ctx) => {
      const q = String(args.query || '').toLowerCase().trim();
      if (!q) return { error: 'query ontbreekt' };
      let rows = (await readVoorraadRows()).filter((r) => String(r.sku).toLowerCase().includes(q));
      if (!ctx.isHQ) rows = ctx.allowed.size ? rows.filter((r) => ctx.allowed.has(String(r.store))) : [];
      return { query: q, regels: rows.slice(0, 60).map((r) => ({ winkel: r.store, sku: r.sku, voorraad: r.voorraad, ideaal: r.ideaal })) };
    }
  },
  {
    id: 'product_audit', tiers: ['hq'],
    desc: 'Samenvatting van de Shopify product-zichtbaarheid-audit (verborgen, geen collectie, niet online, online zonder foto).',
    args: {},
    handler: async () => {
      const a = await readProductAudit();
      if (!a) return { error: 'Nog geen product-audit beschikbaar (draait dagelijks).' };
      return { gescand: a.counts?.totaal, zichtbaar: a.counts?.zichtbaar, gaten: a.bucketCounts, laatst: a.refreshedAt };
    }
  }
];

function extractJson(text) {
  let s = String(text || '').trim().replace(/^```(json)?/i, '').replace(/```$/i, '').trim();
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  return JSON.parse(s);
}

/**
 * Beantwoord een vraag met de HQ-bot.
 * @param {{question, personnelId, allowedStores}} input
 *   allowedStores = de winkels die de gebruiker mag zien (uit shell-state) —
 *   wordt alleen gebruikt voor store-scoping bij winkel-rollen.
 */
export async function askHqBot({ question, personnelId, allowedStores = [] } = {}) {
  if (!getClaudeKey()) throw new Error('CLAUDE_API_KEY ontbreekt — HQ-bot niet beschikbaar.');
  const q = String(question || '').trim();
  if (!q) throw new Error('Lege vraag.');

  const { tier, role } = await resolveTier(personnelId);
  const isHQ = tier === 'hq';
  const ctx = { isHQ, allowed: new Set((allowedStores || []).map((s) => String(s))) };
  const tools = TOOLS.filter((t) => t.tiers.includes(tier));

  /* Stap 1 — plan. */
  const planSys = `Je bepaalt welke data-tools nodig zijn om een vraag te beantwoorden. Antwoord UITSLUITEND met JSON: {"calls":[{"tool":"<id>","args":{...}}]}. Geen tool nodig of buiten bereik? {"calls":[]}.
Beschikbare tools:
${tools.map((t) => `- ${t.id}: ${t.desc} | args: ${JSON.stringify(t.args)}`).join('\n')}`;
  let calls = [];
  try { calls = (extractJson((await claudeMessage({ system: planSys, user: q, maxTokens: 300, temperature: 0 })).text).calls) || []; }
  catch { calls = []; }

  /* Stap 2 — uitvoeren (permissie-gescoped). */
  const gathered = [];
  for (const c of (Array.isArray(calls) ? calls : []).slice(0, 4)) {
    const tool = tools.find((t) => t.id === c.tool);
    if (!tool) continue;
    try { gathered.push({ tool: tool.id, args: c.args || {}, result: await tool.handler(c.args || {}, ctx) }); }
    catch (e) { gathered.push({ tool: tool.id, error: e.message }); }
  }

  /* Stap 3 — antwoord. */
  const scopeNote = isHQ ? 'Je hebt HQ-toegang (alle winkels).' : `Je mag UITSLUITEND data van deze winkel(s) gebruiken: ${[...ctx.allowed].join(', ') || 'jouw eigen winkel'}. Noem geen andere winkels.`;
  const ansSys = `Je bent de GENTS HQ-bot, een behulpzame interne assistent voor GENTS Herenmode. Beantwoord de vraag uitsluitend op basis van de meegeleverde data. Verzin niets; ontbreekt de data of mag de gebruiker het niet zien, zeg dat eerlijk en kort. Antwoord beknopt en concreet in het Nederlands. ${scopeNote}`;
  const userMsg = `Vraag: ${q}\n\nBeschikbare data (JSON):\n${JSON.stringify(gathered).slice(0, 12000)}`;
  const { text, model } = await claudeMessage({ system: ansSys, user: userMsg, maxTokens: 700, temperature: 0.3 });

  return { answer: String(text || '').trim(), tier, role, usedTools: gathered.map((g) => g.tool), model };
}
