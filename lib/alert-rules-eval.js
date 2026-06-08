/**
 * lib/alert-rules-eval.js
 *
 * Pure evaluatie van slimme-alert-regels tegen de huidige data. Kent alleen de
 * whitelisted trigger-types; voert geen code uit. Geeft per regel terug of hij
 * moet vuren + een bericht + de nieuwe state (voor dedupe/edge-triggering).
 */

import { listBranchesFromConfig } from './business-config.js';

/** Bouw de gedeelde context één keer (de cron geeft de prefetch mee). */
export function buildWarehouseIds() {
  const branches = listBranchesFromConfig({ includeInternal: true });
  return new Set(branches.filter((b) => b.kind === 'warehouse').map((b) => String(b.branchId)));
}

const lc = (v) => String(v == null ? '' : v).toLowerCase().trim();

function evalStockThreshold(rule, ctx) {
  const q = lc(rule.trigger.query);
  const rows = (ctx.voorraadRows || []).filter((r) => lc(r.sku) === q || lc(r.sku).includes(q));
  if (!rows.length) return { fired: false, state: { met: false, value: null, found: false } };
  let value = 0;
  for (const r of rows) {
    if (rule.trigger.scope === 'magazijn') { if (ctx.warehouseIds.has(String(r.filiaalNummer))) value += Number(r.voorraad || 0); }
    else value += Number(r.voorraad || 0);
  }
  const w = Number(rule.trigger.waarde || 0);
  const met = rule.trigger.operator === 'eq' ? value === w : rule.trigger.operator === 'lt' ? value < w : value <= w;
  const prevMet = rule.lastState && rule.lastState.met === true;
  /* Edge-trigger: alleen vuren bij NIEUW betreden van de conditie. */
  const fired = met && !prevMet;
  const opTxt = rule.trigger.operator === 'eq' ? 'is' : rule.trigger.operator === 'lt' ? 'onder' : 'op of onder';
  return {
    fired,
    subject: `Voorraad-alert: ${rule.trigger.query}`,
    message: `De voorraad (${rule.trigger.scope}) van "${rule.trigger.query}" is ${value} stuks — ${opTxt} je drempel van ${w}.`,
    state: { met, value, found: true }
  };
}

function evalSchedule(rule, ctx) {
  const t = rule.trigger;
  const today = ctx.today;            /* 'YYYY-MM-DD' (NL) */
  const dow = ctx.weekday;            /* 0=zo..6=za */
  const dom = ctx.dayOfMonth;         /* 1..31 */
  let matchesDay = false;
  if (t.freq === 'daily') matchesDay = true;
  else if (t.freq === 'weekly') matchesDay = dow === Number(t.weekday);
  else if (t.freq === 'monthly') matchesDay = dom === Number(t.dayOfMonth);
  const hourOk = ctx.hour >= Number(t.hour ?? 8);
  const firedToday = rule.lastFired && String(rule.lastFired).slice(0, 10) === today;
  const fired = matchesDay && hourOk && !firedToday;
  return {
    fired,
    subject: `Reminder: ${rule.naam}`,
    message: t.bericht || rule.naam,
    state: rule.lastState || null
  };
}

function evalNewBolOrder(rule, ctx) {
  const raw = ctx.bolOrders;
  const orders = (raw && Array.isArray(raw.orders)) ? raw.orders : (Array.isArray(raw) ? raw : []);
  const norm = orders
    .map((o) => ({ id: String(o.orderId || o.id || ''), items: (o.orderItems || o.items || []) }))
    .filter((o) => o.id);
  const ids = norm.map((o) => o.id);
  const prev = (rule.lastState && Array.isArray(rule.lastState.seenIds)) ? rule.lastState.seenIds : null;
  /* Eerste run: alleen de huidige orders als baseline registreren, NIET met
     terugwerkende kracht voor de hele cache vuren (anders krijg je in één keer
     een mail met alle bestaande orders). Daarna triggeren op nieuwe order-id's. */
  if (prev === null) return { fired: false, state: { seenIds: ids } };
  const seen = new Set(prev);
  const fresh = norm.filter((o) => !seen.has(o.id));
  const lijst = fresh.slice(0, 25).map((o) => {
    const titels = (o.items || []).map((it) => it.title || it.productTitle || it.ean || '').filter(Boolean).slice(0, 3).join(', ');
    return `• Bol-order ${o.id}${titels ? ` — ${titels}` : ''}`;
  }).join('\n');
  return {
    fired: fresh.length > 0,
    subject: `${fresh.length} nieuwe bol-bestelling${fresh.length === 1 ? '' : 'en'}`,
    message: `Er ${fresh.length === 1 ? 'is een' : 'zijn ' + fresh.length} nieuwe bol-bestelling${fresh.length === 1 ? '' : 'en'} binnengekomen:\n${lijst}`,
    state: { seenIds: ids }
  };
}

function evalEvent(rule, ctx) {
  if (rule.trigger.event === 'new-bol-order') return evalNewBolOrder(rule, ctx);
  if (rule.trigger.event !== 'online-zonder-foto') return { fired: false, state: rule.lastState || null };
  const items = (ctx.audit && ctx.audit.buckets && ctx.audit.buckets.onlineZonderFoto) || [];
  const ids = items.map((p) => String(p.id));
  const seen = new Set((rule.lastState && rule.lastState.seenIds) || []);
  const fresh = items.filter((p) => !seen.has(String(p.id)));
  const fired = fresh.length > 0;
  const lijst = fresh.slice(0, 20).map((p) => `• ${p.title}${p.adminUrl ? ` — ${p.adminUrl}` : ''}`).join('\n');
  return {
    fired,
    subject: `Online zonder foto: ${fresh.length} nieuw artikel(en)`,
    message: `${fresh.length} artikel(en) staan online zonder foto:\n${lijst}`,
    state: { seenIds: ids }
  };
}

/**
 * Evalueer één regel. ctx = { voorraadRows, warehouseIds, audit, today, weekday, dayOfMonth, hour }.
 * @returns {{fired:boolean, subject?:string, message?:string, state?:any}}
 */
export function evaluateRule(rule, ctx) {
  if (!rule || rule.actief === false) return { fired: false };
  try {
    if (rule.trigger.type === 'stock-threshold') return evalStockThreshold(rule, ctx);
    if (rule.trigger.type === 'schedule') return evalSchedule(rule, ctx);
    if (rule.trigger.type === 'event') return evalEvent(rule, ctx);
  } catch (e) {
    return { fired: false, error: e.message };
  }
  return { fired: false };
}
