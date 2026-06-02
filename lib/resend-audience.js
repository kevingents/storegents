/**
 * lib/resend-audience.js
 *
 * Audience-sync naar Resend, met segmentatie per winkel.
 *
 * Bron (AVG-veilig, identiek aan de Spotler-sync): SRS-klanten met
 * AllowMailings=true + geldig e-mail. Segmentatie: de winkel waar de klant zich
 * inschreef (SRS `registeredInBranchId` → winkelnaam via business-config).
 *
 * Doel: Resend Audiences. Resend segmenteert op audience-niveau, dus:
 *   - 1 hoofd-audience met ALLE opt-in contacten ("alle").
 *   - (optioneel) 1 audience per winkel → segmentatie "welke winkel schreef in".
 *
 * Schrijfacties gebeuren ALLEEN bij dryRun=false; de cron schrijft alleen als
 * config.enabled === true. Secret: RESEND_API_KEY (Vercel). Overige config staat
 * in de tool (blob), bewerkbaar via het Instellingen-menu.
 */

import { Resend } from 'resend';
import { getCustomers } from './srs-customers-client.js';
import { branchIdToStoreName } from './business-config.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const CONFIG_PATH = 'marketing/resend-audience-config.json';
const DEFAULTS = {
  enabled: false,
  segmentByStore: true,
  storePrefix: 'GENTS — ',
  mainListName: 'GENTS — Nieuwsbrief (alle opt-in)',
  mainAudienceId: '',
  storeAudiences: {},   // winkelnaam -> audienceId
  maxPerRun: 200,
  synced: {},           // email -> { store, ts }
  lastRun: null,
  lastResult: null
};

export function hasResendKey() { return !!String(process.env.RESEND_API_KEY || '').trim(); }

function client() {
  const key = String(process.env.RESEND_API_KEY || '').trim();
  if (!key) throw new Error('RESEND_API_KEY ontbreekt in Vercel.');
  return new Resend(key);
}

const cleanEmail = (e) => {
  const s = String(e || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isRateLimit = (msg) => /rate.?limit|too many|429/i.test(String(msg || ''));

export async function getResendAudienceConfig() {
  const c = await readJsonBlob(CONFIG_PATH, null).catch(() => null);
  return { ...DEFAULTS, ...(c || {}) };
}

export async function saveResendAudienceConfig(patch = {}) {
  const cur = await getResendAudienceConfig();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await writeJsonBlob(CONFIG_PATH, next);
  return next;
}

/* Alle audiences in het Resend-account (id + naam). */
export async function listResendAudiences() {
  const r = await client().audiences.list();
  if (r.error) throw new Error(r.error.message || 'Resend-audiences ophalen mislukte.');
  const arr = (r.data && (r.data.data || r.data)) || [];
  return Array.isArray(arr) ? arr.map((a) => ({ id: a.id, name: a.name })) : [];
}

/* Audience op naam vinden (uit cache `existing`), anders aanmaken. */
async function ensureAudience(name, existing) {
  const lc = name.toLowerCase();
  const found = (existing || []).find((a) => String(a.name || '').toLowerCase() === lc);
  if (found) return found.id;
  let r = await client().audiences.create({ name });
  if (r.error && isRateLimit(r.error.message)) { await sleep(1100); r = await client().audiences.create({ name }); }
  if (r.error) throw new Error(r.error.message || `Audience "${name}" aanmaken mislukte.`);
  const id = r.data && r.data.id;
  if (id && existing) existing.push({ id, name });
  return id;
}

/* Contact toevoegen aan een audience; 'bestaat al' telt als succes. */
async function addContact(audienceId, c) {
  if (!audienceId) return false;
  const payload = { audienceId, email: c.email, firstName: c.firstName || '', lastName: c.lastName || '', unsubscribed: false };
  let r = await client().contacts.create(payload);
  if (r.error && isRateLimit(r.error.message)) { await sleep(1100); r = await client().contacts.create(payload); }
  if (r.error) {
    if (/already|exist|duplicate|reeds|aanwezig/i.test(r.error.message || '')) return true;
    throw new Error(r.error.message || 'Contact toevoegen mislukte.');
  }
  return true;
}

/* Opt-in kandidaten met winkel verzamelen; stopt zodra genoeg NIEUWE. */
async function collectCandidates(synced, cap, { maxPages = 30, pageSize = 500 } = {}) {
  const seen = new Set();
  const fresh = [];
  let scannedOptIn = 0;
  for (let page = 1; page <= maxPages && fresh.length < cap; page++) {
    let batch;
    try { batch = await getCustomers({ page, pageSize }); } catch (_) { break; }
    const rows = Array.isArray(batch) ? batch : (batch?.customers || batch?.rows || []);
    if (!rows.length) break;
    for (const c of rows) {
      const allow = c.allowMailings === true || String(c.allowMailings).toLowerCase() === 'true';
      const email = cleanEmail(c.email);
      if (!allow || !email || seen.has(email)) continue;
      seen.add(email);
      scannedOptIn++;
      const store = branchIdToStoreName(c.registeredInBranchId) || 'Onbekend';
      if (!synced[email]) fresh.push({ email, firstName: c.firstName || '', lastName: c.lastName || '', store });
    }
    if (rows.length < pageSize) break;
  }
  return { candidates: fresh.slice(0, cap), scannedOptIn };
}

/**
 * @param {object} opts { dryRun=true, limit }
 */
export async function runResendAudienceSync({ dryRun = true, limit } = {}) {
  if (!hasResendKey()) return { connected: false, error: 'RESEND_API_KEY ontbreekt in Vercel.' };
  const cfg = await getResendAudienceConfig();
  const cap = Math.max(1, Number(limit || cfg.maxPerRun || 200));
  const { candidates, scannedOptIn } = await collectCandidates(cfg.synced || {}, cap, { maxPages: dryRun ? 20 : 30 });

  const perStore = {};
  for (const c of candidates) perStore[c.store] = (perStore[c.store] || 0) + 1;

  if (dryRun) {
    return {
      connected: true, dryRun: true, scannedOptIn,
      alreadySynced: Object.keys(cfg.synced || {}).length,
      wouldSyncNow: candidates.length, segmentByStore: cfg.segmentByStore,
      perStore, sample: candidates.slice(0, 10).map((c) => ({ email: c.email, store: c.store }))
    };
  }

  const existing = await listResendAudiences().catch(() => []);
  const mainId = cfg.mainAudienceId || await ensureAudience(cfg.mainListName, existing);
  const storeAudiences = { ...(cfg.storeAudiences || {}) };
  const synced = { ...(cfg.synced || {}) };
  let pushed = 0, errors = 0;

  for (const c of candidates) {
    try {
      await addContact(mainId, c);
      if (cfg.segmentByStore && c.store && c.store !== 'Onbekend') {
        let sid = storeAudiences[c.store];
        if (!sid) { sid = await ensureAudience((cfg.storePrefix || 'GENTS — ') + c.store, existing); if (sid) storeAudiences[c.store] = sid; }
        if (sid) await addContact(sid, c);
      }
      synced[c.email] = { store: c.store, ts: Date.now() };
      pushed++;
    } catch (_) { errors++; }
    await sleep(250); /* Resend rate-limit-vriendelijk */
  }

  const result = { connected: true, ranAt: new Date().toISOString(), scannedOptIn, pushed, errors, batch: candidates.length, perStore };
  await saveResendAudienceConfig({ mainAudienceId: mainId, storeAudiences, synced, lastRun: result.ranAt, lastResult: result });
  return result;
}

/* Eén e-mail naar de hoofd-audience schrijven — veilige test-write. */
export async function testResendContact(email, { firstName = '', lastName = '' } = {}) {
  const e = cleanEmail(email);
  if (!e) throw new Error('Ongeldig e-mailadres.');
  const cfg = await getResendAudienceConfig();
  const existing = await listResendAudiences().catch(() => []);
  const mainId = cfg.mainAudienceId || await ensureAudience(cfg.mainListName, existing);
  await addContact(mainId, { email: e, firstName, lastName });
  if (!cfg.mainAudienceId) await saveResendAudienceConfig({ mainAudienceId: mainId });
  return { mainAudienceId: mainId, email: e };
}
