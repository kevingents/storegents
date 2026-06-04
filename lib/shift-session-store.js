/**
 * lib/shift-session-store.js
 *
 * Shift-sessies = de "wie zit er nu aan de kassa"-laag. Eén actieve shift per
 * IP+store-combo. Geeft elke handeling een duidelijke `actor` (personnelId +
 * naam) zodat retouren, cancels, voucher-uitgiftes en verzendlabels in de
 * audit-trail te traceren zijn naar een specifieke medewerker.
 *
 * Levensduur:
 *   - Start: medewerker kiest uit lijst + vult kassacode in
 *   - Eind: handmatige uitlog OF auto-expiry na N uur inactiviteit (default 12u)
 *
 * Blob shape (admin/shift-sessions.json):
 *   {
 *     "active": {
 *       "<ip>__<storeKey>": {
 *         id: "shft_xxx",
 *         ip: "...",
 *         store: "GENTS Showroom",
 *         personnelId: "1011",
 *         personnelName: "Jorik Douma",
 *         personnelGroupId: "verkoper",
 *         startedAt: "2026-06-04T08:00:00Z",
 *         lastActiveAt: "2026-06-04T14:23:00Z",
 *         expiresAt: "2026-06-04T20:00:00Z",
 *         endedAt: null,
 *         endedReason: null
 *       }
 *     },
 *     "history": [ /* recente afgesloten shifts (last 100) *​/ ]
 *   }
 */

import crypto from 'crypto';
import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'admin/shift-sessions.json';
const MAX_HISTORY = 200;
const DEFAULT_TTL_HOURS = 12;

const clean = (v) => String(v == null ? '' : v).trim();
const normalizeIp = (ip) => clean(ip).toLowerCase();
const normalizeStore = (s) => clean(s);

function shiftKey(ip, store) {
  return `${normalizeIp(ip)}__${normalizeStore(store)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function newShiftId() {
  return 'shft_' + crypto.randomBytes(8).toString('hex');
}

async function readAll() {
  const data = await readJsonBlob(PATH, { active: {}, history: [] }).catch(() => ({ active: {}, history: [] }));
  return {
    active: data?.active && typeof data.active === 'object' ? data.active : {},
    history: Array.isArray(data?.history) ? data.history : []
  };
}

/** Welke shift is op dit (ip, store) actief? null als geen of expired. */
export async function getActiveShift({ ip, store }) {
  const key = shiftKey(ip, store);
  const all = await readAll();
  const s = all.active[key];
  if (!s) return null;
  if (s.endedAt) return null;
  const exp = s.expiresAt ? Date.parse(s.expiresAt) : 0;
  if (exp && exp < Date.now()) return null;
  return s;
}

/** Find alle actieve shifts voor 1 IP (kan 1+ store-context betreffen). */
export async function getActiveShiftsByIp(ip) {
  const target = normalizeIp(ip);
  if (!target) return [];
  const all = await readAll();
  const out = [];
  for (const [k, s] of Object.entries(all.active)) {
    if (!s || s.endedAt) continue;
    const exp = s.expiresAt ? Date.parse(s.expiresAt) : 0;
    if (exp && exp < Date.now()) continue;
    if (normalizeIp(s.ip) === target) out.push(s);
  }
  return out;
}

/** Start een nieuwe shift. Vervangt automatisch een evt. actieve shift op (ip, store). */
export async function startShift({ ip, store, personnelId, personnelName, personnelGroupId, ttlHours = DEFAULT_TTL_HOURS, actor = 'self' }) {
  const ipN = normalizeIp(ip);
  const storeN = normalizeStore(store);
  if (!ipN) throw new Error('IP ontbreekt voor shift-start.');
  if (!storeN) throw new Error('Winkel ontbreekt voor shift-start.');
  if (!personnelId) throw new Error('personnelId ontbreekt voor shift-start.');

  const key = shiftKey(ipN, storeN);
  const id = newShiftId();
  const startedAt = nowIso();
  const expiresAt = new Date(Date.now() + Math.max(1, Number(ttlHours)) * 3600 * 1000).toISOString();

  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { active: { ...(cur.active || {}) }, history: Array.isArray(cur.history) ? [...cur.history] : [] }
      : { active: {}, history: [] };

    /* Sluit een eventuele voorgaande shift op dezelfde key af + verplaats naar history. */
    const prev = data.active[key];
    if (prev && !prev.endedAt) {
      const closed = { ...prev, endedAt: startedAt, endedReason: 'replaced' };
      data.history.unshift(closed);
    }

    data.active[key] = {
      id,
      ip: ipN,
      store: storeN,
      personnelId: clean(personnelId),
      personnelName: clean(personnelName),
      personnelGroupId: clean(personnelGroupId),
      startedAt,
      lastActiveAt: startedAt,
      expiresAt,
      endedAt: null,
      endedReason: null,
      startedBy: actor
    };

    /* Houd history bij MAX_HISTORY entries. */
    if (data.history.length > MAX_HISTORY) data.history.length = MAX_HISTORY;
    return data;
  }, { fallback: { active: {}, history: [] } });

  return { id, ip: ipN, store: storeN, personnelId, personnelName, startedAt, expiresAt };
}

/** Heartbeat: update lastActiveAt + verleng expiresAt. */
export async function touchShift({ ip, store }) {
  const ipN = normalizeIp(ip);
  const storeN = normalizeStore(store);
  const key = shiftKey(ipN, storeN);
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { active: { ...(cur.active || {}) }, history: Array.isArray(cur.history) ? [...cur.history] : [] }
      : { active: {}, history: [] };
    const s = data.active[key];
    if (s && !s.endedAt) {
      const now = nowIso();
      const newExp = new Date(Date.now() + DEFAULT_TTL_HOURS * 3600 * 1000).toISOString();
      data.active[key] = { ...s, lastActiveAt: now, expiresAt: newExp };
    }
    return data;
  }, { fallback: { active: {}, history: [] } });
}

/** Sluit een actieve shift af. */
export async function endShift({ ip, store, reason = 'manual' }) {
  const ipN = normalizeIp(ip);
  const storeN = normalizeStore(store);
  const key = shiftKey(ipN, storeN);
  let ended = null;
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { active: { ...(cur.active || {}) }, history: Array.isArray(cur.history) ? [...cur.history] : [] }
      : { active: {}, history: [] };
    const s = data.active[key];
    if (s && !s.endedAt) {
      ended = { ...s, endedAt: nowIso(), endedReason: clean(reason) || 'manual' };
      data.history.unshift(ended);
      delete data.active[key];
      if (data.history.length > MAX_HISTORY) data.history.length = MAX_HISTORY;
    }
    return data;
  }, { fallback: { active: {}, history: [] } });
  return ended;
}

/** Auto-cleanup voor expired shifts (gebruikt door cron). */
export async function reapExpiredShifts() {
  const now = Date.now();
  let reaped = 0;
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { active: { ...(cur.active || {}) }, history: Array.isArray(cur.history) ? [...cur.history] : [] }
      : { active: {}, history: [] };
    for (const [k, s] of Object.entries(data.active)) {
      if (!s) { delete data.active[k]; continue; }
      const exp = s.expiresAt ? Date.parse(s.expiresAt) : 0;
      if (exp && exp < now) {
        const closed = { ...s, endedAt: nowIso(), endedReason: 'expired' };
        data.history.unshift(closed);
        delete data.active[k];
        reaped += 1;
      }
    }
    if (data.history.length > MAX_HISTORY) data.history.length = MAX_HISTORY;
    return data;
  }, { fallback: { active: {}, history: [] } });
  return reaped;
}

/** Admin-view: alle shifts (actief + history). */
export async function listAllShifts({ limit = 100 } = {}) {
  const all = await readAll();
  return {
    active: Object.values(all.active),
    history: all.history.slice(0, Math.max(0, Number(limit) || 100))
  };
}
