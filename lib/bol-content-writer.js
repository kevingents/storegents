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

const clean = (v) => String(v == null ? '' : v).trim();

/* Map ons content-model → bol content-attributen. Alleen niet-lege waarden.
   NB: attribuut-id's zijn de bol-standaardnamen; per producttype kan bol een
   afwijkende id verwachten — daarom eerst dry-run + review. */
export function buildBolPayload(item) {
  const attr = (id, value) => (clean(value) ? [{ id, values: [{ value: clean(value) }] }] : []);
  const attributes = [
    ...attr('EAN', item.ean),
    ...attr('Title', item.titel),
    ...attr('Kleur', item.kleur),
    ...attr('Kleur volgens fabrikant', item.kleur),
    ...attr('Maat', item.maat),
    ...attr('Materiaal', item.materiaal),
    ...attr('Samenstelling', item.samenstelling),
    ...attr('Pasvorm', item.pasvorm),
    ...attr('Sluiting', item.sluiting),
    ...attr('Doelgroep', 'Heren'),
    ...attr('Productgroep', item.hoofdgroep)
  ];
  return { language: 'nl', attributes };
}

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
