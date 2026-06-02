/**
 * lib/email-template-store.js
 *
 * Bewerkbaar e-mail-thema voor alle nieuwsbrieven/automations. In de tool
 * bewerkbaar (blob), niet in Vercel. Levert het thema dat automations-core's
 * emailShell/productCard/ctaButton gebruiken.
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';
import { EMAIL_THEME_DEFAULTS } from './automations-core.js';

const PATH = 'marketing/email-template.json';

export async function getEmailTheme() {
  const t = await readJsonBlob(PATH, null).catch(() => null);
  return { ...EMAIL_THEME_DEFAULTS, ...(t || {}) };
}

export async function saveEmailTheme(patch = {}) {
  const cur = await getEmailTheme();
  const next = { ...cur, ...patch, updatedAt: new Date().toISOString() };
  await writeJsonBlob(PATH, next);
  return next;
}

export { EMAIL_THEME_DEFAULTS };
