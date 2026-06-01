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
const EMPTY = { inkoop: {}, hr: {}, notify: {}, merchandiser: {}, updatedAt: null };

const clean = (v) => String(v == null ? '' : v).trim();
const asList = (v) => {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean);
  return clean(v).split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
};
const asNum = (v, def = 0) => { const n = Number(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : def; };

export async function readPortalConfig() {
  const d = await readJsonBlob(PATH, EMPTY);
  const o = (d && typeof d === 'object') ? d : {};
  return {
    inkoop: { ...(o.inkoop || {}) },
    hr: { ...(o.hr || {}) },
    notify: { ...(o.notify || {}) },
    merchandiser: { ...(o.merchandiser || {}) },
    updatedAt: o.updatedAt || null
  };
}

/** Merchandiser-alert-drempels met defaults (zo blijft de tool werken zonder config). */
export function merchandiserAlertConfig(cfg) {
  const m = (cfg && cfg.merchandiser) || {};
  return {
    alertsEnabled: m.alertsEnabled !== false,
    misgrijpenDrempel: Number.isFinite(m.misgrijpenDrempel) ? m.misgrijpenDrempel : 50,
    overvoorraadDrempel: Number.isFinite(m.overvoorraadDrempel) ? m.overvoorraadDrempel : 25000,
    herverdelingDrempel: Number.isFinite(m.herverdelingDrempel) ? m.herverdelingDrempel : 100,
    alertGroep: clean(m.alertGroep),
    alertGroepNaam: clean(m.alertGroepNaam),
    verplaatsEnabled: m.verplaatsEnabled === true
  };
}

/**
 * Sla (deel van) de config op. Patch wordt per sectie gemerged (shallow), met
 * normalisatie van bekende velden. Returnt de nieuwe volledige config.
 */
export async function savePortalConfig(patch = {}, actor = 'admin') {
  await mutateJsonBlob(PATH, (d0) => {
    const d = (d0 && typeof d0 === 'object') ? d0 : { ...EMPTY };
    const next = { inkoop: { ...(d.inkoop || {}) }, hr: { ...(d.hr || {}) }, notify: { ...(d.notify || {}) }, merchandiser: { ...(d.merchandiser || {}) } };

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
      if (p.verzuimTypes !== undefined) next.hr.verzuimTypes = asList(p.verzuimTypes);
      if (p.verzuimTargetPct !== undefined) next.hr.verzuimTargetPct = Math.max(0, asNum(p.verzuimTargetPct, 0));
    }
    if (patch.notify) {
      const p = patch.notify;
      if (p.hrNotifyEmail !== undefined) next.notify.hrNotifyEmail = clean(p.hrNotifyEmail);
    }
    if (patch.merchandiser) {
      const p = patch.merchandiser;
      if (p.alertsEnabled !== undefined) next.merchandiser.alertsEnabled = Boolean(p.alertsEnabled);
      if (p.misgrijpenDrempel !== undefined) next.merchandiser.misgrijpenDrempel = Math.max(0, Math.round(asNum(p.misgrijpenDrempel, 50)));
      if (p.overvoorraadDrempel !== undefined) next.merchandiser.overvoorraadDrempel = Math.max(0, Math.round(asNum(p.overvoorraadDrempel, 25000)));
      if (p.herverdelingDrempel !== undefined) next.merchandiser.herverdelingDrempel = Math.max(0, Math.round(asNum(p.herverdelingDrempel, 100)));
      if (p.alertGroep !== undefined) next.merchandiser.alertGroep = clean(p.alertGroep);
      if (p.alertGroepNaam !== undefined) next.merchandiser.alertGroepNaam = clean(p.alertGroepNaam);
      if (p.verplaatsEnabled !== undefined) next.merchandiser.verplaatsEnabled = Boolean(p.verplaatsEnabled);
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = clean(actor) || 'admin';
    return next;
  }, { fallback: { ...EMPTY } });
  return readPortalConfig();
}
