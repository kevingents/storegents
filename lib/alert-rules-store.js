/**
 * lib/alert-rules-store.js
 *
 * Door-gebruiker-gedefinieerde "slimme alerts": een prompt wordt (door Claude)
 * vertaald naar een GESTRUCTUREERDE regel uit een vaste whitelist. Hier staat
 * de opslag + validatie. Er wordt NOOIT code uitgevoerd — alleen data die aan
 * dit schema voldoet wordt geaccepteerd; de cron kent alleen deze trigger-/
 * actie-types.
 *
 * Blob: alerts/rules.json  { rules: [...] }
 *
 * Regel:
 *   { id, owner, ownerEmail, ownerStores:[], naam, trigger, actie,
 *     actief, createdAt, createdBy, lastFired, lastState }
 *
 * Trigger-whitelist:
 *   stock-threshold  { query, operator:'lte'|'lt'|'eq', waarde:Number, scope:'magazijn'|'totaal' }
 *   schedule         { freq:'daily'|'weekly'|'monthly', weekday?0-6, dayOfMonth?1-31, hour?0-23, bericht }
 *   event            { event:'online-zonder-foto' }
 *
 * Actie-whitelist: { email:bool, notificatie:bool }
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'alerts/rules.json';
const MAX_RULES = 2000;

export const TRIGGER_TYPES = ['stock-threshold', 'schedule', 'event'];
export const STOCK_OPERATORS = ['lte', 'lt', 'eq'];
export const STOCK_SCOPES = ['magazijn', 'totaal'];
export const SCHEDULE_FREQS = ['daily', 'weekly', 'monthly'];
export const EVENT_TYPES = ['online-zonder-foto'];

const clamp = (n, lo, hi, def) => { const v = Number(n); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : def; };
const clean = (v) => String(v == null ? '' : v).trim();
const genId = () => 'alr_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/**
 * Valideer + normaliseer een (door AI of UI aangeleverde) regel. Gooit alles weg
 * wat niet binnen de whitelist valt. Retourneert { ok, rule?, error? }.
 */
export function validateRule(raw = {}) {
  const t = raw.trigger || {};
  const type = clean(t.type);
  if (!TRIGGER_TYPES.includes(type)) return { ok: false, error: `Onbekend trigger-type: ${type || '(leeg)'}` };

  let trigger;
  if (type === 'stock-threshold') {
    const query = clean(t.query || t.sku || t.artikel);
    if (!query) return { ok: false, error: 'Voorraad-alert: artikel/SKU ontbreekt.' };
    const operator = STOCK_OPERATORS.includes(t.operator) ? t.operator : 'lte';
    const waarde = clamp(t.waarde ?? t.value ?? 0, 0, 1000000, 0);
    const scope = STOCK_SCOPES.includes(t.scope) ? t.scope : 'totaal';
    trigger = { type, query, operator, waarde, scope };
  } else if (type === 'schedule') {
    const freq = SCHEDULE_FREQS.includes(t.freq) ? t.freq : 'weekly';
    trigger = { type, freq, hour: clamp(t.hour ?? 8, 0, 23, 8), bericht: clean(t.bericht || raw.naam || 'Reminder').slice(0, 300) };
    if (freq === 'weekly') trigger.weekday = clamp(t.weekday ?? 1, 0, 6, 1);
    if (freq === 'monthly') trigger.dayOfMonth = clamp(t.dayOfMonth ?? 1, 1, 28, 1);
  } else { /* event */
    const event = EVENT_TYPES.includes(t.event) ? t.event : '';
    if (!event) return { ok: false, error: `Onbekend event: ${clean(t.event) || '(leeg)'}` };
    trigger = { type, event };
  }

  const actie = {
    email: raw.actie?.email !== false, /* default aan */
    notificatie: raw.actie?.notificatie !== false
  };
  if (!actie.email && !actie.notificatie) actie.notificatie = true; /* minstens één kanaal */

  const rule = {
    naam: clean(raw.naam || raw.titel).slice(0, 160) || autoName(trigger),
    trigger,
    actie,
    actief: raw.actief !== false
  };
  return { ok: true, rule };
}

function autoName(trigger) {
  if (trigger.type === 'stock-threshold') return `Voorraad ${trigger.query} ${trigger.operator === 'eq' ? '=' : '≤'} ${trigger.waarde}`;
  if (trigger.type === 'schedule') return `Reminder (${trigger.freq})`;
  return 'Artikel online zonder foto';
}

export async function listRules({ owner = '' } = {}) {
  const d = await readJsonBlob(PATH, { rules: [] });
  const rules = Array.isArray(d?.rules) ? d.rules : [];
  return owner ? rules.filter((r) => String(r.owner) === String(owner)) : rules;
}

export async function getRule(id) {
  const rules = await listRules();
  return rules.find((r) => r.id === id) || null;
}

/** Maak of werk een regel bij. owner-velden worden server-side gezet. */
export async function upsertRule(input = {}, ctx = {}) {
  const v = validateRule(input);
  if (!v.ok) throw new Error(v.error);
  let saved = null;
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.rules)) ? d0 : { rules: [] };
    const id = clean(input.id);
    const existing = id ? d.rules.find((r) => r.id === id) : null;
    if (existing) {
      Object.assign(existing, v.rule);
      saved = existing;
    } else {
      saved = {
        id: genId(),
        owner: clean(ctx.owner || input.owner) || 'admin',
        ownerEmail: clean(ctx.ownerEmail || input.ownerEmail),
        ownerStores: Array.isArray(ctx.ownerStores) ? ctx.ownerStores.map(String) : [],
        ...v.rule,
        createdAt: new Date().toISOString(),
        createdBy: clean(ctx.owner || 'admin'),
        lastFired: null,
        lastState: null
      };
      d.rules = [saved, ...d.rules].slice(0, MAX_RULES);
    }
    return d;
  }, { fallback: { rules: [] }, cacheMaxAge: 0 });
  return saved;
}

export async function setRuleActive(id, actief) {
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.rules)) ? d0 : { rules: [] };
    const r = d.rules.find((x) => x.id === id);
    if (r) r.actief = !!actief;
    return d;
  }, { fallback: { rules: [] }, cacheMaxAge: 0 });
}

export async function deleteRule(id) {
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.rules)) ? d0 : { rules: [] };
    d.rules = d.rules.filter((r) => r.id !== id);
    return d;
  }, { fallback: { rules: [] }, cacheMaxAge: 0 });
}

/** Persisteer alleen de evaluatie-state (zonder te vuren) — voor edge-triggering. */
export async function updateRuleState(id, state) {
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.rules)) ? d0 : { rules: [] };
    const r = d.rules.find((x) => x.id === id);
    if (r && state !== undefined) r.lastState = state;
    return d;
  }, { fallback: { rules: [] }, cacheMaxAge: 0 });
}

/** Markeer een regel als gevuurd (lastFired + optionele state voor dedupe). */
export async function markFired(id, state = null) {
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && Array.isArray(d0.rules)) ? d0 : { rules: [] };
    const r = d.rules.find((x) => x.id === id);
    if (r) { r.lastFired = new Date().toISOString(); if (state !== null) r.lastState = state; }
    return d;
  }, { fallback: { rules: [] }, cacheMaxAge: 0 });
}
