/**
 * lib/resend-sender.js
 *
 * Per-winkel afzender voor Resend. Maakt mails persoonlijk: een klant die zich
 * in Den Haag inschreef krijgt post van `denhaag@mail.gents.nl`.
 *
 * Eén geverifieerd subdomein (mail.gents.nl) dekt álle lokale adressen, dus per
 * winkel hoeft alleen het lokale deel + weergavenaam ingesteld te worden. Config
 * staat in de tool (blob), bewerkbaar via het Instellingen-menu; alleen de
 * RESEND_API_KEY blijft een Vercel-secret.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { listBranchesFromConfig } from './business-config.js';

const CONFIG_PATH = 'marketing/resend-sender-config.json';
const DEFAULTS = {
  domain: 'mail.gents.nl',
  fromName: 'GENTS',
  defaultLocalPart: 'hallo',
  perStore: {} // winkelnaam -> { localPart, fromName }
};

const clean = (v) => String(v == null ? '' : v).trim();

/* "Den Haag" → "denhaag" (diacritics weg, alleen a-z0-9). */
export function storeSlug(store) {
  return clean(store).toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '');
}

export async function getStoreSenderConfig() {
  const c = await readJsonBlob(CONFIG_PATH, null).catch(() => null);
  return { ...DEFAULTS, ...(c || {}), perStore: { ...(c && c.perStore || {}) } };
}

export async function saveStoreSenderConfig(patch = {}) {
  const cur = await getStoreSenderConfig();
  const next = { ...cur, ...patch, perStore: { ...cur.perStore, ...(patch.perStore || {}) }, updatedAt: new Date().toISOString() };
  await writeJsonBlob(CONFIG_PATH, next);
  return next;
}

/* Afzenderstring "GENTS Den Haag <denhaag@mail.gents.nl>" voor een winkel.
   Zonder winkel → het standaard-adres. */
export function storeFromAddress(store, cfg = DEFAULTS) {
  const domain = clean(cfg.domain) || 'mail.gents.nl';
  const baseName = clean(cfg.fromName) || 'GENTS';
  const s = clean(store);
  if (!s) {
    return `${baseName} <${clean(cfg.defaultLocalPart) || 'hallo'}@${domain}>`;
  }
  const override = (cfg.perStore || {})[s] || {};
  const localPart = clean(override.localPart) || storeSlug(s) || 'hallo';
  const name = clean(override.fromName) || `${baseName} ${s}`;
  return `${name} <${localPart}@${domain}>`;
}

/* Reply-to per winkel (zelfde adres) — handig voor automations. */
export function storeReplyTo(store, cfg = DEFAULTS) {
  const m = /<([^>]+)>/.exec(storeFromAddress(store, cfg));
  return m ? m[1] : '';
}

/* Voor de UI: alle retail-winkels met hun (effectieve) afzender. */
export async function listStoreSenders() {
  const cfg = await getStoreSenderConfig();
  const branches = listBranchesFromConfig({ includeInternal: false });
  return branches.map((b) => {
    const override = (cfg.perStore || {})[b.store] || {};
    return {
      store: b.store,
      localPart: clean(override.localPart) || storeSlug(b.store),
      fromName: clean(override.fromName) || `${cfg.fromName} ${b.store}`,
      from: storeFromAddress(b.store, cfg),
      custom: !!(override.localPart || override.fromName)
    };
  });
}
