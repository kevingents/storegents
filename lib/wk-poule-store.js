/**
 * WK Poule store — alle blob-data rondom de WK Poule feature.
 *
 * Storage-pads:
 *   wk-poule/prizes.json          — admin-beheerde prijzen + totaalpot
 *   wk-poule/schedule.json        — wedstrijden + admin-ingevulde uitslagen
 *   wk-poule/bonus-questions.json — admin-beheerde bonusvragen (50 ptn etc.)
 *   wk-poule/predictions/<userId>.json — voorspellingen per gebruiker
 *   wk-poule/bonus-answers/<userId>.json — bonusvraag-antwoorden per gebruiker
 *   wk-poule/scores.json          — gecomputed leaderboard (5min cache)
 */

import { list } from '@vercel/blob';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

/* ─────────────────────── Prijzen ─────────────────────── */

const PRIZES_PATH = 'wk-poule/prizes.json';

/**
 * Default-prijzen — wordt gebruikt als de blob nog niet bestaat. Admin kan
 * via UI overschrijven. Zodra opgeslagen is dat de waarheid.
 */
const DEFAULT_PRIZES = {
  items: [
    {
      id: 'prize-1',
      position: 1,
      name: 'Weekendtrip voor 2 personen',
      description: 'Hotel + diner naar keuze',
      value: 750,
      quantity: 1,
      currency: 'EUR',
      type: 'main'
    },
    {
      id: 'prize-2',
      position: 2,
      name: 'VIP-arrangement Eredivisie',
      description: '2 kaarten + bedrijfslunch',
      value: 400,
      quantity: 1,
      currency: 'EUR',
      type: 'main'
    },
    {
      id: 'prize-3',
      position: 3,
      name: 'GENTS Maatpak op maat',
      description: '100% personaliseerbaar bij GENTS',
      value: 350,
      quantity: 1,
      currency: 'EUR',
      type: 'main'
    },
    {
      id: 'prize-troost',
      position: 99,
      name: 'Troostprijs',
      description: 'GENTS-shirt + voucher t.w.v. €75',
      value: 75,
      quantity: 10,
      currency: 'EUR',
      type: 'consolation'
    }
  ],
  manualPotOverride: null,
  notes: '',
  updatedAt: null,
  updatedBy: null
};

export async function getPrizes() {
  const data = await readJsonBlob(PRIZES_PATH, null);
  if (!data) return DEFAULT_PRIZES;
  /* Merge met defaults: missende velden krijgen default-waarden zodat
     oude blobs niet breken na schema-uitbreiding. */
  return {
    items: Array.isArray(data.items) ? data.items : DEFAULT_PRIZES.items,
    manualPotOverride: data.manualPotOverride ?? null,
    notes: String(data.notes || ''),
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null
  };
}

export function computeTotalPot(prizes) {
  if (prizes && Number.isFinite(prizes.manualPotOverride)) return prizes.manualPotOverride;
  const items = prizes?.items || [];
  return items.reduce((sum, p) => sum + Number(p.value || 0) * Number(p.quantity || 1), 0);
}

export async function setPrizes(newData, updatedBy = 'admin') {
  const next = {
    items: Array.isArray(newData?.items) ? newData.items.map(sanitizeItem) : [],
    manualPotOverride: newData?.manualPotOverride !== undefined && newData.manualPotOverride !== null
      ? Number(newData.manualPotOverride) || null
      : null,
    notes: String(newData?.notes || '').slice(0, 500),
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || 'admin').slice(0, 100)
  };
  await writeJsonBlob(PRIZES_PATH, next);
  return next;
}

export async function addPrize(item, updatedBy = 'admin') {
  const current = await getPrizes();
  const newItem = sanitizeItem({
    id: 'prize-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    ...item
  });
  const next = { ...current, items: [...current.items, newItem] };
  return setPrizes(next, updatedBy);
}

export async function updatePrize(id, patch, updatedBy = 'admin') {
  const current = await getPrizes();
  const idx = current.items.findIndex((p) => p.id === id);
  if (idx === -1) throw new Error(`Prijs '${id}' niet gevonden.`);
  const items = [...current.items];
  items[idx] = sanitizeItem({ ...items[idx], ...patch, id });
  return setPrizes({ ...current, items }, updatedBy);
}

export async function deletePrize(id, updatedBy = 'admin') {
  const current = await getPrizes();
  const items = current.items.filter((p) => p.id !== id);
  return setPrizes({ ...current, items }, updatedBy);
}

function sanitizeItem(raw) {
  return {
    id: String(raw.id || ''),
    position: Number(raw.position) || 99,
    name: String(raw.name || '').slice(0, 200),
    description: String(raw.description || '').slice(0, 500),
    value: Number(raw.value) || 0,
    quantity: Math.max(1, Number(raw.quantity) || 1),
    currency: String(raw.currency || 'EUR').slice(0, 5).toUpperCase(),
    type: ['main', 'consolation', 'bonus'].includes(raw.type) ? raw.type : 'main'
  };
}

/* ─────────────────────── Schedule (wedstrijden) ─────────────────────── */

const SCHEDULE_PATH = 'wk-poule/schedule.json';

/**
 * Default-schedule met voorbeeld-wedstrijden voor de poule-MVP. Admin kan
 * deze later overschrijven met de officiële FIFA-loting. Tijden in UTC.
 *
 * Structuur per match:
 *   { id, group, round, datetime, home, away, homeScore?, awayScore?, status }
 *   - status: 'scheduled' | 'live' | 'finished'
 *   - home/away: { code (ISO-2), name, flag (emoji of ISO-2 voor JS rendering) }
 */
const DEFAULT_SCHEDULE = {
  matches: [
    { id: 'm1',  group: 'A', round: 'groep', datetime: '2026-06-11T16:00:00Z', home: { code: 'MX', name: 'Mexico' },        away: { code: 'NL', name: 'Nederland' },        status: 'scheduled' },
    { id: 'm2',  group: 'B', round: 'groep', datetime: '2026-06-11T19:00:00Z', home: { code: 'US', name: 'Verenigde Staten' }, away: { code: 'BR', name: 'Brazilië' },         status: 'scheduled' },
    { id: 'm3',  group: 'C', round: 'groep', datetime: '2026-06-12T16:00:00Z', home: { code: 'CA', name: 'Canada' },        away: { code: 'AR', name: 'Argentinië' },       status: 'scheduled' },
    { id: 'm4',  group: 'D', round: 'groep', datetime: '2026-06-12T19:00:00Z', home: { code: 'FR', name: 'Frankrijk' },     away: { code: 'DE', name: 'Duitsland' },        status: 'scheduled' },
    { id: 'm5',  group: 'E', round: 'groep', datetime: '2026-06-13T16:00:00Z', home: { code: 'ES', name: 'Spanje' },        away: { code: 'PT', name: 'Portugal' },         status: 'scheduled' },
    { id: 'm6',  group: 'F', round: 'groep', datetime: '2026-06-13T19:00:00Z', home: { code: 'IT', name: 'Italië' },        away: { code: 'BE', name: 'België' },           status: 'scheduled' },
    { id: 'm7',  group: 'A', round: 'groep', datetime: '2026-06-15T16:00:00Z', home: { code: 'NL', name: 'Nederland' },     away: { code: 'JP', name: 'Japan' },            status: 'scheduled' },
    { id: 'm8',  group: 'B', round: 'groep', datetime: '2026-06-15T19:00:00Z', home: { code: 'BR', name: 'Brazilië' },      away: { code: 'KR', name: 'Zuid-Korea' },       status: 'scheduled' },
    { id: 'm9',  group: 'C', round: 'groep', datetime: '2026-06-16T16:00:00Z', home: { code: 'AR', name: 'Argentinië' },    away: { code: 'CR', name: 'Costa Rica' },       status: 'scheduled' },
    { id: 'm10', group: 'D', round: 'groep', datetime: '2026-06-16T19:00:00Z', home: { code: 'DE', name: 'Duitsland' },     away: { code: 'DK', name: 'Denemarken' },       status: 'scheduled' }
  ],
  updatedAt: null,
  updatedBy: null
};

export async function getSchedule() {
  const data = await readJsonBlob(SCHEDULE_PATH, null);
  if (!data || !Array.isArray(data.matches) || !data.matches.length) {
    return DEFAULT_SCHEDULE;
  }
  return {
    matches: data.matches,
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null
  };
}

export async function setMatchResult(matchId, { homeScore, awayScore }, updatedBy = 'admin') {
  const data = await getSchedule();
  const idx = (data.matches || []).findIndex((m) => m.id === matchId);
  if (idx === -1) throw new Error(`Wedstrijd '${matchId}' niet gevonden.`);
  data.matches[idx] = {
    ...data.matches[idx],
    homeScore: Number(homeScore),
    awayScore: Number(awayScore),
    status: 'finished',
    resultEnteredAt: new Date().toISOString(),
    resultEnteredBy: String(updatedBy)
  };
  data.updatedAt = new Date().toISOString();
  await writeJsonBlob(SCHEDULE_PATH, data);
  return data.matches[idx];
}

/* ─────────────────────── Bonus-vragen ─────────────────────── */

const BONUS_QUESTIONS_PATH = 'wk-poule/bonus-questions.json';

const DEFAULT_BONUS_QUESTIONS = {
  questions: [
    { id: 'bq-champion',  label: 'Wie wordt wereldkampioen?',              type: 'text', points: 50, placeholder: 'bv. Brazilië' },
    { id: 'bq-topscorer', label: 'Wie wordt topscorer van het toernooi?', type: 'text', points: 30, placeholder: 'bv. Kylian Mbappé' },
    { id: 'bq-final',     label: 'Welke twee landen spelen de finale?',    type: 'text', points: 25, placeholder: 'bv. Brazilië - Frankrijk' },
    { id: 'bq-surprise',  label: 'Verrassing van het toernooi?',           type: 'text', points: 15, placeholder: 'bv. Marokko in halve finale' },
    { id: 'bq-goals',     label: 'Totaal aantal doelpunten in het toernooi?', type: 'number', points: 20, placeholder: '120' }
  ],
  updatedAt: null,
  updatedBy: null
};

export async function getBonusQuestions() {
  const data = await readJsonBlob(BONUS_QUESTIONS_PATH, null);
  if (!data || !Array.isArray(data.questions) || !data.questions.length) {
    return DEFAULT_BONUS_QUESTIONS;
  }
  return {
    questions: data.questions,
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null
  };
}

export async function setBonusQuestions(questions, updatedBy = 'admin') {
  const payload = {
    questions: Array.isArray(questions) ? questions : [],
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy)
  };
  await writeJsonBlob(BONUS_QUESTIONS_PATH, payload);
  return payload;
}

/* ─────────────────────── Regels (read-only config) ─────────────────────── */

const RULES_PATH = 'wk-poule/rules.json';

const DEFAULT_RULES = {
  scoring: [
    { label: 'Juiste uitslag (exact)',         points: 10 },
    { label: 'Goede toto (winnaar + gelijk)', points: 5 },
    { label: 'Goed doelsaldo',                 points: 3 }
  ],
  deadlines: [
    { label: 'Voorspelling per wedstrijd', value: 'Tot 1 uur voor aftrap' },
    { label: 'Bonusvragen',                value: 'Tot het WK begint (eerste wedstrijd)' }
  ],
  updatedAt: null
};

export async function getRules() {
  const data = await readJsonBlob(RULES_PATH, null);
  return data && Array.isArray(data.scoring) ? data : DEFAULT_RULES;
}

/* ─────────────────────── Voorspellingen / Predictions ─────────────────────── */

const PREDICTIONS_PREFIX = 'wk-poule/predictions/';

function emailToKey(email) {
  /* email → veilige blob-key (lowercase, alleen [a-z0-9._-]) */
  return String(email || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

/**
 * Sla een poule-inzending op. Eén entry per e-mailadres — opnieuw indienen
 * overschrijft of merge'd op de bestaande zodat gebruikers per onderdeel
 * (match-uitslag, bonusvraag) kunnen aanpassen.
 *
 * @param {object} prediction
 * @param {object} [opts] { merge: boolean (default true) }
 * @returns {object} de opgeslagen prediction (inclusief submittedAt + revision-count)
 */
export async function savePrediction(prediction, opts = {}) {
  const merge = opts.merge !== false;
  const email = String(prediction?.email || '').trim().toLowerCase();
  if (!email) throw new Error('E-mailadres is verplicht.');

  const key = emailToKey(email);
  if (!key) throw new Error('E-mailadres bevat geen geldige tekens.');

  const path = `${PREDICTIONS_PREFIX}${key}.json`;
  const existing = await readJsonBlob(path, null);

  const revision = existing?.revision ? Number(existing.revision) + 1 : 1;
  const firstSubmittedAt = existing?.firstSubmittedAt || new Date().toISOString();

  /* Match-uitslagen: merge per match-id, niet vervangen, zodat een edit van
     één match niet alle andere wist. */
  const mergedMatches = merge
    ? { ...(existing?.matches || {}), ...(prediction?.matches || {}) }
    : (prediction?.matches || {});

  /* Bonus-antwoorden: idem, merge per question-id. */
  const mergedBonus = merge
    ? { ...(existing?.bonus || {}), ...(prediction?.bonus || {}) }
    : (prediction?.bonus || {});

  const payload = {
    email,
    name: String(prediction?.name || existing?.name || '').trim(),
    store: String(prediction?.store || existing?.store || '').trim(),
    personnelNumber: String(prediction?.personnelNumber || existing?.personnelNumber || '').trim(),
    /* Legacy velden behouden voor backwards compat */
    champion: String(prediction?.champion || existing?.champion || '').trim(),
    topScorer: String(prediction?.topScorer || existing?.topScorer || '').trim(),
    surprise: String(prediction?.surprise || existing?.surprise || '').trim(),
    /* Nieuwe structuur: matches = { 'm1': { home: 2, away: 1 }, ... } */
    matches: mergedMatches,
    /* bonus = { 'bq-champion': 'Brazilië', 'bq-goals': 120, ... } */
    bonus: mergedBonus,
    revision,
    firstSubmittedAt,
    submittedAt: new Date().toISOString()
  };

  await writeJsonBlob(path, payload);
  return payload;
}

/**
 * Haal voorspelling van één gebruiker op (op e-mail).
 */
export async function getPrediction(email) {
  const key = emailToKey(email);
  if (!key) return null;
  return readJsonBlob(`${PREDICTIONS_PREFIX}${key}.json`, null);
}

/**
 * Lijst alle voorspellingen — voor admin-overzicht + deelnemerscount.
 * Defensive: bij storage-fout retourneren we een lege array zodat de UI
 * niet kapotgaat (counter toont gewoon 0).
 */
export async function listPredictions() {
  try {
    const out = [];
    let cursor;
    do {
      const result = await list({ prefix: PREDICTIONS_PREFIX, cursor, limit: 1000 });
      const blobs = result.blobs || [];
      for (const blob of blobs) {
        try {
          const response = await fetch(blob.url);
          if (!response.ok) continue;
          const data = await response.json();
          if (data && data.email) out.push(data);
        } catch (e) { /* skip kapotte entry */ }
      }
      cursor = result.cursor;
    } while (cursor);
    return out;
  } catch (error) {
    console.error('listPredictions error:', error);
    return [];
  }
}

/**
 * Lichtgewicht statistiek: aantal unieke deelnemers (zonder de hele lijst
 * te downloaden). We doen alleen list() en tellen de blob-bestanden.
 */
export async function countPredictions() {
  try {
    let count = 0;
    let cursor;
    do {
      const result = await list({ prefix: PREDICTIONS_PREFIX, cursor, limit: 1000 });
      count += (result.blobs || []).length;
      cursor = result.cursor;
    } while (cursor);
    return count;
  } catch (error) {
    console.error('countPredictions error:', error);
    return 0;
  }
}
