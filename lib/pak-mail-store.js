/**
 * lib/pak-mail-store.js
 *
 * Post-purchase pak-mail automation: 7 dagen na aankoop van een pak krijgt
 * de klant een mail met verzorgingstips, uithang-instructies, vermaak-info
 * en bijpassende producten met gratis-verzending-coupon.
 *
 * Twee blobs:
 *   1. marketing/pak-mail-config.json — globale + per-winkel config
 *   2. marketing/pak-mail-sent.json   — wie heeft al een pak-mail gehad
 *
 * Idempotency-window: 6 maanden. Een klant die in januari een pak koopt
 * krijgt 1× een pak-mail; bij een tweede pak in augustus (= >6mnd) opnieuw.
 */

import { readJsonBlob, writeJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const CONFIG_PATH = 'marketing/pak-mail-config.json';
const SENT_PATH = 'marketing/pak-mail-sent.json';

/* Standaard content — door admin per winkel overschrijfbaar. Velden ondersteunen
   HTML. Bron-van-waarheid voor "Reset naar default"-knop in de UI. */
export const PAK_MAIL_DEFAULTS = {
  enabled: false,
  senderName: 'GENTS',
  senderEmail: 'service@mail.gents.nl',
  subject: 'Je nieuwe pak — alles wat je moet weten',
  /* Aantal dagen na aankoop voordat de mail wordt verstuurd. 7 = pak is
     ontvangen + 1× gedragen → goede timing voor verzorgings-tips. */
  delayDays: 7,
  /* Idempotency-window in dagen. Binnen deze periode geen tweede pak-mail
     naar dezelfde klant, ook niet bij een tweede pak-aankoop. */
  cooldownDays: 180,
  /* Visueel */
  logoUrl: '',
  heroImageUrl: '',
  heroImageLink: 'https://gents.nl/collections/pakken',
  ctaLabel: 'BEKIJK BIJPASSENDE ARTIKELEN',
  ctaUrl: 'https://gents.nl/collections/overhemden',
  /* Coupon voor gratis verzending bij bestelling van bijpassende artikelen. */
  couponCode: 'PAKBEZOEK',
  couponLabel: 'Gratis verzending bij je volgende bestelling',
  couponExpiry: '60 dagen geldig',
  /* Content-blokken (HTML). De admin kan elk blok aanpassen of leegmaken
     (leeg = blok wordt overgeslagen in de mail). */
  introText: 'Bedankt voor je nieuwe pak bij <strong>GENTS</strong>. We hopen dat je er net zo blij van wordt als wij. Hieronder vind je onze tips om er jaren plezier van te hebben.',
  unboxingTitle: 'Net uit de doos',
  unboxingText: '<ul style="margin:0;padding-left:20px;line-height:1.7"><li><strong>Hang je pak eerst 24 uur op</strong> in een ruimte met normale luchtvochtigheid. Vouwen en kreukels van het verzendproces vallen er vanzelf uit.</li><li>Gebruik een <strong>brede houten kledinghanger</strong> die de schoudervorm volgt. Te smal = uitzakkende schouders na een paar weken.</li><li>Laat de stof <strong>ademen</strong> — geen plastic hoes eroverheen tenzij je hem langer dan een maand wegbergt.</li><li>De eerste keer dragen rekt de stof zich een halve maat — dat is normaal en hoort erbij. Wacht hier even mee voordat je naar de vermaakkamer gaat.</li></ul>',
  careTitle: 'Verzorging',
  careText: '<ul style="margin:0;padding-left:20px;line-height:1.7"><li><strong>Stomen, geen strijken</strong> — een stoomstrijkijzer of een hete douche-badkamer doet wonderen voor frisse kreukels.</li><li>Borstel je pak na elk dragen met een <strong>natuurharige kledingborstel</strong> in de richting van de stofdraad. Verlengt de levensduur enorm.</li><li><strong>24 uur rusttijd</strong> tussen draagmomenten. De wollen vezels veren dan terug naar hun oorspronkelijke vorm.</li><li>Vlek? <strong>Niet zelf wassen.</strong> Onze winkels kennen een goede stomerij — vraag ons advies.</li></ul>',
  alterationsTitle: 'Maat niet perfect?',
  alterationsText: 'Geen zorgen — in elk van onze <strong>19 GENTS-winkels in Nederland én Antwerpen</strong> kun je je pak vakkundig laten vermaken. Mouwen, broek, taille, kraag — alles op maat. <a href="https://gents.nl/pages/kleding-vermaken-bij-gents" style="color:#0A1F33;font-weight:600;text-decoration:underline">Bekijk alle prijzen en informatie &rarr;</a>',
  /* "Vul zelf aan" — extra blok dat de admin per winkel kan invullen voor
     unieke tips, evenementen of seizoens-info. Leeg = niet gerenderd. */
  extraTitle: '',
  extraText: '',
  /* Signature in footer (persoonlijk). */
  signatureName: '',
  signatureRole: '',
  signaturePhone: '',
  signatureMobile: '',
  addressLine: 'GENTS B.V., Lemelerbergweg 15, 1101AJ Amsterdam'
};

/* ─── Config get/save ──────────────────────────────────────────────────── */

const GLOBAL_DEFAULTS = {
  config: { ...PAK_MAIL_DEFAULTS },
  lookbackDays: 30,   /* hoeveel dagen terug kijken voor pak-aankopen */
  maxPerRun: 50,
  updatedAt: null
};

export async function getPakMailConfig() {
  const cur = await readJsonBlob(CONFIG_PATH, null).catch(() => null);
  if (!cur || typeof cur !== 'object') return { ...GLOBAL_DEFAULTS, config: { ...PAK_MAIL_DEFAULTS } };
  return {
    ...GLOBAL_DEFAULTS,
    ...cur,
    config: { ...PAK_MAIL_DEFAULTS, ...(cur.config || {}) }
  };
}

export async function savePakMailConfig(patch = {}) {
  await mutateJsonBlob(CONFIG_PATH, (cur) => {
    const next = (cur && typeof cur === 'object') ? { ...cur } : {};
    if (patch.config && typeof patch.config === 'object') {
      next.config = { ...(next.config || {}), ...patch.config };
    }
    for (const k of ['lookbackDays', 'maxPerRun']) {
      if (patch[k] != null) next[k] = patch[k];
    }
    next.updatedAt = new Date().toISOString();
    return next;
  }, { fallback: GLOBAL_DEFAULTS });
  return getPakMailConfig();
}

export function getPakMailDefaults() {
  return { ...PAK_MAIL_DEFAULTS };
}

/* ─── Sent-tracking met 6-maanden cooldown ────────────────────────────── */

export async function readPakMailSentMap() {
  const data = await readJsonBlob(SENT_PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.sent && typeof data.sent === 'object') return data;
  return { sent: {}, updatedAt: null };
}

/* Voor cooldown-check: geef terug of klant binnen X dagen al een pak-mail
   heeft gehad (true = geblokkeerd). */
export function isWithinCooldown(sentEntry, cooldownDays) {
  if (!sentEntry?.sentAt) return false;
  const sentMs = new Date(sentEntry.sentAt).getTime();
  if (!Number.isFinite(sentMs)) return false;
  const ageMs = Date.now() - sentMs;
  const cooldownMs = Math.max(1, Number(cooldownDays || 180)) * 24 * 3600 * 1000;
  return ageMs < cooldownMs;
}

export async function markPakMailSent(email, info = {}) {
  const e = String(email || '').trim().toLowerCase();
  if (!e) return;
  await mutateJsonBlob(SENT_PATH, (cur) => {
    const data = (cur && typeof cur === 'object' && cur.sent && typeof cur.sent === 'object')
      ? { sent: { ...cur.sent } }
      : { sent: {} };
    data.sent[e] = {
      email: e,
      sku: String(info.sku || ''),
      orderId: String(info.orderId || ''),
      branchId: String(info.branchId || ''),
      sentAt: new Date().toISOString(),
      messageId: String(info.messageId || '')
    };
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { sent: {} } });
}

/* Batch-write voor cron: meerdere entries in 1 blob-call (race-safe). */
export async function markPakMailSentBatch(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return;
  const valid = entries
    .map((it) => ({ ...it, email: String(it?.email || '').trim().toLowerCase() }))
    .filter((it) => it.email);
  if (!valid.length) return;
  await mutateJsonBlob(SENT_PATH, (cur) => {
    const data = (cur && typeof cur === 'object' && cur.sent && typeof cur.sent === 'object')
      ? { sent: { ...cur.sent } }
      : { sent: {} };
    const now = new Date().toISOString();
    for (const it of valid) {
      data.sent[it.email] = {
        email: it.email,
        sku: String(it.sku || ''),
        orderId: String(it.orderId || ''),
        branchId: String(it.branchId || ''),
        sentAt: it.sentAt || now,
        messageId: String(it.messageId || '')
      };
    }
    data.updatedAt = now;
    return data;
  }, { fallback: { sent: {} } });
}

export async function readPakMailStats() {
  const data = await readPakMailSentMap();
  const list = Object.values(data.sent || {});
  const byBranch = {};
  for (const r of list) {
    const b = r.branchId || '?';
    byBranch[b] = (byBranch[b] || 0) + 1;
  }
  return {
    totalSent: list.length,
    byBranch,
    last5: list.sort((a, b) => String(b.sentAt || '').localeCompare(String(a.sentAt || ''))).slice(0, 5)
  };
}
