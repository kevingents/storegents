/**
 * Spotler audience-sync — pusht opt-in GENTS-klanten naar een eigen Spotler
 * temp-lijst, als motor onder nieuwsbrieven/automations.
 *
 * Bron (AVG-veilig): SRS-klanten met AllowMailings=true + geldig e-mail.
 * Doel: een door de portal beheerde temp-lijst (externalTemporaryListId).
 * Schrijfacties (POST /contact, POST /templist) gebeuren ALLEEN bij
 * dryRun=false; de cron schrijft alleen als config.enabled === true.
 *
 * API: POST /contact {contact,update,purge} · POST /templist {externalTemporaryListId,name,contacts}
 *      · POST /templist/{id} {contacts:[email]}
 */

import { spotlerRequest, hasSpotlerCreds } from './spotler-client.js';
import { getCustomers } from './srs-customers-client.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const CONFIG_PATH = 'marketing/spotler-audience-config.json';
const DEFAULTS = {
  enabled: false,
  listId: 'gents-portal-sync',
  listName: 'GENTS portal-sync (opt-in)',
  maxPerRun: 300,
  synced: {},        // email -> timestamp
  lastRun: null,
  lastResult: null
};

const cleanEmail = (e) => {
  const s = String(e || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) ? s : '';
};

export async function getAudienceConfig() {
  const c = await readJsonBlob(CONFIG_PATH, null);
  return { ...DEFAULTS, ...(c || {}) };
}

export async function saveAudienceConfig(patch = {}) {
  const cur = await getAudienceConfig();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await writeJsonBlob(CONFIG_PATH, next);
  return next;
}

export async function listTempLists() {
  if (!hasSpotlerCreds()) return [];
  const d = await spotlerRequest('GET', 'templist', { query: { pageSize: '100' } });
  return Array.isArray(d) ? d : (d?.templists || d?.lists || d?.items || []);
}

/* Upsert 1 contact: insert; valt bij 'bestaat al' terug op update. */
export async function upsertContact(email) {
  const contact = { externalId: email, properties: { email }, channels: [{ name: 'EMAIL', value: true }] };
  try {
    return await spotlerRequest('POST', 'contact', { body: { contact, update: false, purge: false } });
  } catch (e) {
    if (/exist|already|reeds|duplicate|aanwezig/i.test(e.message || '')) {
      return await spotlerRequest('POST', 'contact', { body: { contact, update: true, purge: false } });
    }
    throw e;
  }
}

/* Maak de sync-lijst aan (idempotent — faalt stil als 'ie al bestaat). */
async function ensureList(cfg) {
  try {
    await spotlerRequest('POST', 'templist', { body: { externalTemporaryListId: cfg.listId, name: cfg.listName, contacts: [] } });
  } catch (_) { /* bestaat waarschijnlijk al */ }
}

async function addToList(cfg, emails) {
  if (!emails.length) return;
  await spotlerRequest('POST', `templist/${encodeURIComponent(cfg.listId)}`, { body: { contacts: emails } });
}

/* Paginerend door SRS, opt-in + e-mail verzamelen; stopt zodra genoeg NIEUWE. */
async function collectNewCandidates(synced, cap, { maxPages = 30, pageSize = 500 } = {}) {
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
      if (allow && email && !seen.has(email)) {
        seen.add(email);
        scannedOptIn++;
        if (!synced[email]) fresh.push(email);
      }
    }
    if (rows.length < pageSize) break;
  }
  return { newEmails: fresh.slice(0, cap), scannedOptIn };
}

/**
 * @param {object} opts { dryRun=true, limit }
 */
export async function runAudienceSync({ dryRun = true, limit } = {}) {
  if (!hasSpotlerCreds()) return { connected: false, error: 'Spotler niet gekoppeld.' };
  const cfg = await getAudienceConfig();
  const cap = Math.max(1, Number(limit || cfg.maxPerRun || 300));
  const { newEmails, scannedOptIn } = await collectNewCandidates(cfg.synced || {}, cap, { maxPages: dryRun ? 20 : 30 });

  if (dryRun) {
    return { connected: true, dryRun: true, scannedOptIn, alreadySynced: Object.keys(cfg.synced || {}).length, wouldSyncNow: newEmails.length, sample: newEmails.slice(0, 10) };
  }

  await ensureList(cfg);
  const synced = { ...(cfg.synced || {}) };
  let pushed = 0;
  let errors = 0;
  const ok = [];
  for (const email of newEmails) {
    try { await upsertContact(email); synced[email] = Date.now(); ok.push(email); pushed++; }
    catch (_) { errors++; }
  }
  try { await addToList(cfg, ok); } catch (_) { /* lijst-add best-effort */ }

  const result = { connected: true, ranAt: new Date().toISOString(), scannedOptIn, pushed, errors, batch: newEmails.length };
  await saveAudienceConfig({ synced, lastRun: result.ranAt, lastResult: result });
  return result;
}
