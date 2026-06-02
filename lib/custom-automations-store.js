/**
 * lib/custom-automations-store.js
 *
 * Door de gebruiker (of AI) gemaakte automations, op basis van een GEWHITELISTE
 * regel — nooit vrije code. De runner voert ze uit met dezelfde scan/dedupe als
 * de vaste automations. Opslag: blob marketing/custom-automations.json.
 *
 * Regel-schema (alle velden optioneel; leeg = geen filter):
 *   lapsedMinDays / lapsedMaxDays  : laatste aankoop X..Y dagen geleden
 *   boughtHoofdgroep: [str]         : kocht eerder uit deze hoofdgroep(en)
 *   registeredStores: [str]         : ingeschreven in deze winkel(s)
 *   birthdayWindowDays              : binnen X dagen van de verjaardag
 *   minReceiptCount                 : minimaal N aankopen (loyaliteit)
 * Inhoud: subject, intro, buttonLabel, buttonUrl, voucherText.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/custom-automations.json';
const clean = (v) => String(v == null ? '' : v).trim();

export async function listCustomAutomations() {
  const l = await readJsonBlob(PATH, []).catch(() => []);
  return Array.isArray(l) ? l : [];
}
async function writeAll(list) { await writeJsonBlob(PATH, list); }

export async function getCustomAutomation(id) {
  return (await listCustomAutomations()).find((a) => a.id === id) || null;
}
export async function patchCustomAutomation(id, patch) {
  const list = await listCustomAutomations();
  const i = list.findIndex((a) => a.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch, updatedAt: new Date().toISOString() };
  await writeAll(list);
  return list[i];
}
export async function deleteCustomAutomation(id) {
  await writeAll((await listCustomAutomations()).filter((a) => a.id !== id));
  return true;
}

const num = (v, min, max) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : null; };

export function validateCustomRule(input = {}) {
  const rule = {};
  if (input.lapsedMinDays != null) rule.lapsedMinDays = num(input.lapsedMinDays, 1, 2000);
  if (input.lapsedMaxDays != null) rule.lapsedMaxDays = num(input.lapsedMaxDays, 1, 3000);
  if (input.birthdayWindowDays != null) rule.birthdayWindowDays = num(input.birthdayWindowDays, 0, 30);
  if (input.minReceiptCount != null) rule.minReceiptCount = num(input.minReceiptCount, 1, 1000);
  if (Array.isArray(input.boughtHoofdgroep)) rule.boughtHoofdgroep = input.boughtHoofdgroep.map(clean).filter(Boolean).slice(0, 12);
  if (Array.isArray(input.registeredStores)) rule.registeredStores = input.registeredStores.map(clean).filter(Boolean).slice(0, 30);
  /* lege arrays weglaten */
  for (const k of ['boughtHoofdgroep', 'registeredStores']) if (rule[k] && !rule[k].length) delete rule[k];
  for (const k of Object.keys(rule)) if (rule[k] == null) delete rule[k];
  return rule;
}

export function ruleNeedsTransactions(rule = {}) {
  return rule.lapsedMinDays != null || rule.lapsedMaxDays != null || (Array.isArray(rule.boughtHoofdgroep) && rule.boughtHoofdgroep.length > 0);
}

export function validateContent(input = {}) {
  return {
    subject: clean(input.subject).slice(0, 140) || 'Een berichtje van GENTS',
    intro: clean(input.intro).slice(0, 1200),
    buttonLabel: clean(input.buttonLabel).slice(0, 60) || 'Bekijk de collectie',
    buttonUrl: clean(input.buttonUrl).slice(0, 300),
    voucherText: clean(input.voucherText).slice(0, 200)
  };
}

export function describeRule(rule = {}) {
  const p = [];
  if (rule.lapsedMinDays != null || rule.lapsedMaxDays != null) p.push(`laatste aankoop ${rule.lapsedMinDays || 0}–${rule.lapsedMaxDays || '∞'} dagen geleden`);
  if (rule.boughtHoofdgroep && rule.boughtHoofdgroep.length) p.push(`kocht: ${rule.boughtHoofdgroep.join(' / ')}`);
  if (rule.registeredStores && rule.registeredStores.length) p.push(`winkel: ${rule.registeredStores.join(' / ')}`);
  if (rule.birthdayWindowDays != null) p.push(`rond verjaardag (±${rule.birthdayWindowDays}d)`);
  if (rule.minReceiptCount != null) p.push(`≥ ${rule.minReceiptCount} aankopen`);
  return p.join(' · ') || 'alle opt-in klanten';
}

export async function createCustomAutomation({ label, rule, content }) {
  const list = await listCustomAutomations();
  const r = validateCustomRule(rule);
  const obj = {
    id: 'cust-' + Math.random().toString(36).slice(2, 9),
    label: clean(label).slice(0, 80) || 'Nieuwe automation',
    enabled: false,
    needsTransactions: ruleNeedsTransactions(r),
    rule: r,
    content: validateContent(content),
    maxPerRun: 80,
    sent: {}, processed: {}, lastRun: null, lastResult: null,
    createdAt: new Date().toISOString()
  };
  list.push(obj);
  await writeAll(list);
  return obj;
}
