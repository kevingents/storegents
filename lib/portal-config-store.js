/**
 * lib/portal-config-store.js
 *
 * Centrale, in-de-tool instelbare portal-configuratie (blob-backed). Doel: niet
 * voor elk schakelaartje of ID een Vercel env-var nodig — de gebruiker stelt het
 * in via het Instellingen-menu. Alleen échte secrets (tokens/wachtwoorden) blijven
 * in Vercel.
 *
 * Blob admin/portal-config.json:
 *   {
 *     inkoop: { srsConfigurationId, srsOrderType, srsPushEnabled(bool) },
 *     hr:     { excludeDepts:[str], officeDepts:[str] },
 *     notify: { hrNotifyEmail },
 *     updatedAt
 *   }
 *
 * Env-vars blijven als optionele fallback werken, maar de bron van waarheid is
 * deze config zodra een waarde is ingevuld.
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const PATH = 'admin/portal-config.json';
const EMPTY = { inkoop: {}, hr: {}, notify: {}, updatedAt: null };

const clean = (v) => String(v == null ? '' : v).trim();
const asList = (v) => {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  return clean(v).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
};

export async function readPortalConfig() {
  const d = await readJsonBlob(PATH, EMPTY);
  const o = (d && typeof d === 'object') ? d : {};
  return {
    inkoop: { ...(o.inkoop || {}) },
    hr: { ...(o.hr || {}) },
    notify: { ...(o.notify || {}) },
    updatedAt: o.updatedAt || null
  };
}

/**
 * Sla (deel van) de config op. Patch wordt per sectie gemerged (shallow), met
 * normalisatie van bekende velden. Returnt de nieuwe volledige config.
 */
export async function savePortalConfig(patch = {}, actor = 'admin') {
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const next = { inkoop: { ...(d.inkoop || {}) }, hr: { ...(d.hr || {}) }, notify: { ...(d.notify || {}) } };

    if (patch.inkoop) {
      const p = patch.inkoop;
      if (p.srsConfigurationId !== undefined) next.inkoop.srsConfigurationId = clean(p.srsConfigurationId);
      if (p.srsOrderType !== undefined) next.inkoop.srsOrderType = clean(p.srsOrderType);
      if (p.srsPushEnabled !== undefined) next.inkoop.srsPushEnabled = Boolean(p.srsPushEnabled);
    }
    if (patch.hr) {
      const p = patch.hr;
      if (p.excludeDepts !== undefined) next.hr.excludeDepts = asList(p.excludeDepts);
      if (p.officeDepts !== undefined) next.hr.officeDepts = asList(p.officeDepts);
    }
    if (patch.notify) {
      const p = patch.notify;
      if (p.hrNotifyEmail !== undefined) next.notify.hrNotifyEmail = clean(p.hrNotifyEmail);
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = clean(actor) || 'admin';
    return next;
  }, { fallback: { ...EMPTY } });
  return readPortalConfig();
}
