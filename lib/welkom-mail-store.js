/**
 * lib/welkom-mail-store.js
 *
 * Config + idempotency-state voor de welkom-mail automation.
 *
 * Twee blobs:
 *   1. marketing/welkom-mail-config.json — per-winkel configuratie (enabled,
 *      subject, fromLocalPart, htmlOverride). Default: alleen Amsterdam aan
 *      voor de eerste test, rest uit.
 *   2. marketing/welkom-mail-sent.json — wie heeft al een welkom-mail gehad?
 *      { email -> { store, branchId, sentAt, messageId? } }
 */

import { readJsonBlob, writeJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const CONFIG_PATH = 'marketing/welkom-mail-config.json';
const SENT_PATH = 'marketing/welkom-mail-sent.json';

/* Standaard alleen Amsterdam (branchId 15) aan — test-modus.
   Andere winkels kunnen via UI later opt-in.

   Inhoudelijke velden (mogen leeg blijven → blok wordt overgeslagen):
     - openingHours        bv. "Ma-Vr 10:00-18:00 · Za 10:00-17:30 · Zo gesloten"
     - addressLine         korte 1-regel adres + tel (voor footer)
     - alterationsInfo     vermaakkosten of dienstverlening (broek korter, etc.)
     - loyaltyInfo         puntensysteem uitleg
     - voucherCode         optioneel cadeau-code in welkom-blok */
const DEFAULT_CONFIG = {
  stores: {
    'GENTS Amsterdam': {
      enabled: true,
      branchId: '15',
      /* Afzender: persoonlijke naam | GENTS + persoonlijk@gents.nl
         (zoals Fosse Bakx | GENTS <fosse@gents.nl>). Vroeger fromLocalPart →
         amsterdam@gents.mail.nl, maar gebruiker wil persoonlijke afzender. */
      senderName: '',  /* bv. "Fosse Bakx | GENTS" */
      senderEmail: '', /* bv. "fosse@gents.nl" */
      /* Backwards-compat: fromLocalPart wordt nog gelezen als senderEmail leeg is. */
      fromLocalPart: '',
      subject: 'Welkom bij GENTS Amsterdam',
      /* Openingstijden: leeg laten = haal uit Google Places (zie googlePlaceId).
         Met openingHours als handmatige fallback bij Google-fail. */
      googlePlaceId: '',
      openingHours: 'Ma t/m Vr 10:00–18:00 · Za 10:00–17:30 · Zo gesloten',
      /* Hero-afbeelding bovenin de mail (optioneel — leeg = geen hero-blok).
         URL naar Shopify CDN of MailPlus/Spotler-asset. */
      heroImageUrl: '',
      heroImageLink: 'https://gents.nl',
      /* CTA-knop onder de tekst. */
      ctaLabel: 'BEZOEK ONZE WEBSHOP',
      ctaUrl: 'https://gents.nl',
      /* Signature (footer-blok). Multi-line; ondersteunt <br>. */
      signatureName: '',
      signatureRole: '',  /* bv. "B2B" of "Winkelmanager Amsterdam" */
      signaturePhone: '',
      signatureMobile: '',
      addressLine: 'GENTS B.V., Lemelerbergweg 15, 1101AJ Amsterdam',
      alterationsInfo: 'Bij GENTS kun je je kleding direct vakkundig laten vermaken — broeken korter, mouwen, taille en meer. Vermaak is bij ons <strong>inbegrepen bij aanschaf van een nieuw pak</strong>. Voor losse aanpassingen hanteren we vaste tarieven. <a href="https://gents.nl/pages/kleding-vermaken-bij-gents" style="color:#0A1F33;font-weight:600;text-decoration:underline">Bekijk alle prijzen en informatie &rarr;</a>',
      loyaltyInfo: 'Vanaf nu spaar je automatisch <strong>punten</strong> bij elke aankoop. Bij elke € 1 besteed krijg je 1 punt. Bij 250 punten ontvang je een voucher van € 10, bij 500 punten een voucher van € 25 — automatisch verwerkt in je klantenkaart.',
      voucherCode: '' /* optioneel — leeg = geen voucher in mail */
    }
  },
  /* Hoeveel uur terug kijken in SRS voor "nieuwe registraties"? */
  lookbackHours: 24,
  /* Max aantal mails per cron-run (rate-limit + veiligheid) */
  maxPerRun: 50,
  updatedAt: null
};

export async function getWelkomMailConfig() {
  const cur = await readJsonBlob(CONFIG_PATH, null).catch(() => null);
  if (!cur || typeof cur !== 'object') return { ...DEFAULT_CONFIG };
  return {
    ...DEFAULT_CONFIG,
    ...cur,
    stores: { ...DEFAULT_CONFIG.stores, ...(cur.stores || {}) }
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
    const cfg = (cur && typeof cur === 'object') ? cur : { ...DEFAULT_CONFIG };
    cfg.stores = cfg.stores || {};
    cfg.stores[storeName] = { ...(cfg.stores[storeName] || {}), ...storePatch };
    cfg.updatedAt = new Date().toISOString();
    return cfg;
  }, { fallback: DEFAULT_CONFIG });
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
