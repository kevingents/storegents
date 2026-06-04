/**
 * lib/welkom-mail-store.js
 *
 * Config + idempotency-state voor de welkom-mail automation.
 *
 * Twee blobs:
 *   1. marketing/welkom-mail-config.json — per-winkel configuratie (enabled,
 *      subject, sender, openingHours, hero, CTA, signature, etc).
 *   2. marketing/welkom-mail-sent.json — wie heeft al een welkom-mail gehad?
 *      { email -> { store, branchId, sentAt, messageId? } }
 *
 * Alle bekende retail-winkels (uit business-config) krijgen automatisch een
 * tab in de admin-modal — ook als ze nog niet in de blob staan. Defaults
 * worden samengesteld uit STORE_DEFAULTS (algemene template) + STORE_OVERRIDES
 * (per-winkel afwijking, bv. branchId of standaard adresregel).
 */

import { readJsonBlob, writeJsonBlob, mutateJsonBlob } from './json-blob-store.js';
import { listBranchesFromConfig } from './business-config.js';

const CONFIG_PATH = 'marketing/welkom-mail-config.json';
const SENT_PATH = 'marketing/welkom-mail-sent.json';

/* ─── Default content templates ────────────────────────────────────────── */

/* Algemene defaults — gelden voor elke winkel tenzij overschreven. Deze
   bron-van-waarheid wordt ook gebruikt voor de "Reset naar default" knop in
   de admin-modal (per veld terugzetten zonder verlies van andere config). */
export const STORE_DEFAULTS = {
  enabled: false,
  branchId: '',
  senderName: '',                 /* auto-gegenereerd uit store-naam in buildSender */
  senderEmail: '',                /* auto: {winkel}@mail.gents.nl */
  fromLocalPart: '',              /* legacy fallback */
  subject: 'Welkom bij GENTS',
  googlePlaceId: '',
  openingHours: 'Ma t/m Vr 10:00–18:00 · Za 10:00–17:30 · Zo gesloten',
  heroImageUrl: '',
  heroImageLink: 'https://gents.nl',
  ctaLabel: 'BEZOEK ONZE WEBSHOP',
  ctaUrl: 'https://gents.nl',
  signatureName: '',
  signatureRole: '',
  signaturePhone: '',
  signatureMobile: '',
  logoUrl: '',
  addressLine: '',
  alterationsInfo: 'Bij GENTS kun je je kleding direct vakkundig laten vermaken — broeken korter, mouwen, taille en meer. Vermaak is bij ons <strong>inbegrepen bij aanschaf van een nieuw pak</strong>. Voor losse aanpassingen hanteren we vaste tarieven. <a href="https://gents.nl/pages/kleding-vermaken-bij-gents" style="color:#0A1F33;font-weight:600;text-decoration:underline">Bekijk alle prijzen en informatie &rarr;</a>',
  loyaltyInfo: 'Vanaf nu spaar je automatisch <strong>punten</strong> bij elke aankoop. Bij elke € 1 besteed krijg je 1 punt. Bij 250 punten ontvang je een voucher van € 10, bij 500 punten een voucher van € 25 — automatisch verwerkt in je klantenkaart.',
  voucherCode: ''
};

/* Per-winkel afwijkingen op STORE_DEFAULTS. Alleen Amsterdam staat default
   "enabled:true" voor pilot. Andere winkels worden auto-toegevoegd met
   enabled:false zodat de admin ze kan activeren. */
const STORE_OVERRIDES = {
  'GENTS Amsterdam': {
    enabled: true,
    branchId: '15',
    senderName: 'GENTS Amsterdam',
    senderEmail: 'amsterdam@mail.gents.nl',
    subject: 'Welkom bij GENTS Amsterdam',
    addressLine: 'GENTS B.V., Lemelerbergweg 15, 1101AJ Amsterdam'
  }
};

/* ─── Auto-inject alle retail-winkels ──────────────────────────────────── */

/* Bouw de complete default-stores map: voor elke bekende retail-winkel uit
   business-config maken we een config-entry (STORE_DEFAULTS + per-winkel
   override + auto branchId/subject/sender als die nog leeg zijn). */
function buildDefaultStores() {
  const stores = {};
  for (const branch of listBranchesFromConfig({ includeInternal: false })) {
    const storeName = branch.store;
    if (!storeName) continue;
    const shortName = storeName.replace(/^GENTS\s+/i, '');
    const shortKey = shortName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const override = STORE_OVERRIDES[storeName] || {};
    stores[storeName] = {
      ...STORE_DEFAULTS,
      branchId: override.branchId || branch.branchId || '',
      senderName: override.senderName || `GENTS ${shortName}`,
      senderEmail: override.senderEmail || `${shortKey}@mail.gents.nl`,
      subject: override.subject || `Welkom bij GENTS ${shortName}`,
      ...override
    };
  }
  return stores;
}

const DEFAULT_CONFIG = {
  stores: buildDefaultStores(),
  lookbackHours: 24,
  maxPerRun: 50,
  updatedAt: null
};

/* Export voor frontend reset-knop (per-veld terugzetten naar default). */
export function getStoreDefaults(storeName) {
  const all = buildDefaultStores();
  return all[storeName] ? { ...all[storeName] } : { ...STORE_DEFAULTS };
}

export async function getWelkomMailConfig() {
  const cur = await readJsonBlob(CONFIG_PATH, null).catch(() => null);
  /* Eerst defaults voor ALLE bekende winkels, daarna blob-data eroverheen
     mergen. Zo verschijnen nieuwe winkels uit business-config automatisch
     als tab in de UI, zonder dat de blob die expliciet hoeft te bevatten. */
  const allDefaults = buildDefaultStores();
  const blobStores = (cur && typeof cur === 'object' && cur.stores) || {};
  const mergedStores = {};
  /* Begin met alle default-winkels (enabled:false voor de niet-pilots). */
  for (const [name, def] of Object.entries(allDefaults)) {
    mergedStores[name] = { ...def, ...(blobStores[name] || {}) };
  }
  /* Voeg blob-only winkels toe die niet meer in business-config staan
     (bv. handmatig toegevoegde test-store). */
  for (const [name, sc] of Object.entries(blobStores)) {
    if (!mergedStores[name]) mergedStores[name] = { ...STORE_DEFAULTS, ...sc };
  }
  return {
    ...DEFAULT_CONFIG,
    ...(cur || {}),
    stores: mergedStores
  };
}

export async function saveWelkomMailConfig(patch = {}) {
  const cur = await getWelkomMailConfig();
  const next = {
    ...cur,
    ...patch,
    stores: { ...(cur.stores || {}), ...(patch.stores || {}) },
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(CONFIG_PATH, next);
  return next;
}

/* Update per-winkel config (zonder de andere winkels te verliezen). */
export async function saveStoreConfig(storeName, storePatch = {}) {
  await mutateJsonBlob(CONFIG_PATH, (cur) => {
    const cfg = (cur && typeof cur === 'object') ? cur : { stores: {} };
    cfg.stores = cfg.stores || {};
    cfg.stores[storeName] = { ...(cfg.stores[storeName] || {}), ...storePatch };
    cfg.updatedAt = new Date().toISOString();
    return cfg;
  }, { fallback: { stores: {} } });
  return getWelkomMailConfig();
}

/* ─── Sent-tracking ───────────────────────────────────────────────────── */

export async function readSentMap() {
  const data = await readJsonBlob(SENT_PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.sent && typeof data.sent === 'object') return data;
  return { sent: {}, updatedAt: null };
}

export async function hasReceivedWelkomMail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return false;
  const data = await readSentMap();
  return !!data.sent[e];
}

export async function markWelkomMailSent(email, info = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return;
  await mutateJsonBlob(SENT_PATH, (cur) => {
    const data = (cur && typeof cur === 'object' && cur.sent && typeof cur.sent === 'object')
      ? { sent: { ...cur.sent } }
      : { sent: {} };
    data.sent[e] = {
      email: e,
      store: String(info.store || ''),
      branchId: String(info.branchId || ''),
      sentAt: new Date().toISOString(),
      messageId: String(info.messageId || '')
    };
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { sent: {} } });
}

/* Batch-variant: schrijf meerdere sent-entries in 1 blob-write. Voorkomt
   N+1 race condition als 50 mails in 1 run worden verstuurd. */
export async function markWelkomMailSentBatch(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return;
  const validEntries = entries
    .map((it) => ({ ...it, email: String(it?.email || '').trim().toLowerCase() }))
    .filter((it) => it.email);
  if (!validEntries.length) return;
  await mutateJsonBlob(SENT_PATH, (cur) => {
    const data = (cur && typeof cur === 'object' && cur.sent && typeof cur.sent === 'object')
      ? { sent: { ...cur.sent } }
      : { sent: {} };
    const now = new Date().toISOString();
    for (const it of validEntries) {
      data.sent[it.email] = {
        email: it.email,
        store: String(it.store || ''),
        branchId: String(it.branchId || ''),
        sentAt: it.sentAt || now,
        messageId: String(it.messageId || '')
      };
    }
    data.updatedAt = now;
    return data;
  }, { fallback: { sent: {} } });
}

export async function readWelkomMailStats() {
  const sent = await readSentMap();
  const list = Object.values(sent.sent || {});
  const byStore = {};
  for (const r of list) {
    const s = r.store || '?';
    byStore[s] = (byStore[s] || 0) + 1;
  }
  return {
    totalSent: list.length,
    byStore,
    last5: list.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || ''))).slice(0, 5)
  };
}
