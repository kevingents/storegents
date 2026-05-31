/**
 * lib/bol-content-writer.js
 *
 * Bouwt het bol Content-API-payload uit het optimizer-plan en pusht het
 * (POST /retailer/content/products). Standaard DRY-RUN: dan wordt niets naar
 * bol gestuurd maar krijg je exact te zien wat verzonden zou worden — zodat we
 * de attribuut-mapping per producttype eerst kunnen valideren tegen de echte
 * bol-catalogus voordat er live geschreven wordt.
 */

import { bolPost, isBolConfigured } from './bol-client.js';
import { getContentForEan, buildBolContentPlan } from './bol-content-optimizer.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const clean = (v) => String(v == null ? '' : v).trim();
const STATE_PATH = 'marketplace/bol-content-state.json';

/* Bouw een rijkere bol-titel: merk vooraan + producttitel + pasvorm. GEEN maat
   (elke EAN is een maat-variant binnen de family — bol toont de maatkiezer). */
function buildTitle(item) {
  const base = clean(item.titel);
  const merk = clean(item.merk);
  let t = base;
  if (merk && !base.toLowerCase().includes(merk.toLowerCase())) t = `${merk} ${base}`;
  const pas = clean(item.pasvorm);
  if (pas && !t.toLowerCase().includes(pas.toLowerCase())) t = `${t} – ${pas}`;
  return t.slice(0, 200);
}

/* Map ons content-model → bol content-attributen. Alleen niet-lege waarden.
   NB: attribuut-id's zijn de bol-standaardnamen (NL). Per producttype kan bol
   een andere id verwachten of een attribuut afwijzen — daarom valideren we op
   de demo en lezen we de proces-feedback voordat we breed live pushen. */
export function buildBolPayload(item) {
  const attr = (id, value) => (clean(value) ? [{ id, values: [{ value: clean(value).slice(0, 1000) }] }] : []);
  const attributes = [
    ...attr('EAN', item.ean),
    ...attr('Title', buildTitle(item)),
    ...attr('Merk', item.merk || 'GENTS'),
    ...attr('Kleur', item.kleur),
    ...attr('Maat', item.maat),
    ...attr('Materiaal', item.materiaal),
    ...attr('Samenstelling', item.samenstelling),
    ...attr('Pasvorm', item.pasvorm),
    ...attr('Sluiting', item.sluiting),
    ...attr('Doelgroep', 'Heren'),
    ...attr('Kleur volgens fabrikant', item.kleur)
  ];
  return { language: 'nl', attributes };
}

/* Push-criterium: voldoende identiteits-content (merk + kleur + maat). Zonder
   die drie pushen we niets (geen halfbakken content op bol). */
export function isPushReady(item) {
  return Boolean((clean(item.merk) || true) && clean(item.kleur) && clean(item.maat) && clean(item.ean));
}

/* Goedkope content-handtekening om alleen te pushen wat écht wijzigde. */
function signature(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

/**
 * Push content voor een set EAN's.
 * @param {{eans:string[], dryRun?:boolean}} opts  dryRun standaard true.
 * @returns {Promise<object>} { dryRun, aantal, resultaten:[{ean, payload, status?, error?}] }
 */
export async function pushBolContent({ eans = [], dryRun = true } = {}) {
  if (!dryRun && !isBolConfigured()) throw new Error('bol niet gekoppeld — kan niet live pushen.');
  const list = (Array.isArray(eans) ? eans : []).map(clean).filter(Boolean).slice(0, 200);
  if (!list.length) throw new Error('Geen EANs opgegeven.');

  const resultaten = [];
  for (const ean of list) {
    const item = await getContentForEan(ean);
    if (!item) { resultaten.push({ ean, error: 'Geen content-plan voor deze EAN (ververs eerst het plan).' }); continue; }
    const payload = buildBolPayload(item);
    if (dryRun) { resultaten.push({ ean, payload }); continue; }
    try {
      const res = await bolPost('/content/products', payload);
      resultaten.push({ ean, status: clean(res?.status || res?.processStatusId || 'verzonden'), processId: clean(res?.processStatusId || res?.id) });
    } catch (e) { resultaten.push({ ean, error: e.message }); }
  }
  return { dryRun, aantal: resultaten.length, resultaten };
}

/** Ververs het plan (optimizer) — convenience voor de endpoint. */
export async function refreshPlan() { return buildBolContentPlan(); }

/**
 * AUTONOOM: optimaliseer + push de content voor alle push-klare producten.
 * Pusht alleen wat nieuw of gewijzigd is (handtekening-vergelijking) zodat bol
 * niet onnodig wordt belast. Bedoeld voor de cron — draait vanzelf.
 *
 * @param {{maxPush?:number, dryRun?:boolean}} opts
 *   dryRun → niets naar bol; toont alleen kandidaten + voorbeeldpayload.
 * @returns {Promise<object>}
 */
export async function runBolContentAuto({ maxPush = 300, dryRun = false } = {}) {
  const plan = await buildBolContentPlan();
  const state = await readJsonBlob(STATE_PATH, { byEan: {} });
  const byEan = state.byEan || {};

  const pushKlaar = plan.items.filter(isPushReady);
  const kandidaten = [];
  for (const item of pushKlaar) {
    const payload = buildBolPayload(item);
    const sig = signature(JSON.stringify(payload));
    if (byEan[item.ean]?.sig === sig) continue; /* ongewijzigd sinds laatste push */
    kandidaten.push({ ean: item.ean, payload, sig });
  }

  const live = !dryRun && isBolConfigured();
  let gepusht = 0, fouten = 0;
  const resultaten = [];
  for (const c of kandidaten.slice(0, maxPush)) {
    if (!live) { if (resultaten.length < 100) resultaten.push({ ean: c.ean, payload: c.payload }); continue; }
    try {
      const res = await bolPost('/content/products', c.payload);
      byEan[c.ean] = { sig: c.sig, at: new Date().toISOString() };
      gepusht += 1;
      if (resultaten.length < 100) resultaten.push({ ean: c.ean, status: clean(res?.processStatusId || res?.status || 'verzonden') });
    } catch (e) {
      fouten += 1;
      if (resultaten.length < 100) resultaten.push({ ean: c.ean, error: e.message });
    }
  }
  if (live) { try { await writeJsonBlob(STATE_PATH, { refreshedAt: new Date().toISOString(), byEan }); } catch (_) {} }

  return {
    dryRun: !live,
    pushKlaar: pushKlaar.length,
    kandidaten: kandidaten.length,
    gepusht, fouten,
    resterend: Math.max(0, kandidaten.length - maxPush),
    resultaten
  };
}
