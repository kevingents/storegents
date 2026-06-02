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
const EMPTY = { inkoop: {}, hr: {}, notify: {}, merchandiser: {}, forecast: {}, anomaly: {}, gala: {}, marketing: {}, updatedAt: null };

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
    forecast: { ...(o.forecast || {}) },
    anomaly: { ...(o.anomaly || {}) },
    gala: { ...(o.gala || {}) },
    marketing: { ...(o.marketing || {}) },
    updatedAt: o.updatedAt || null
  };
}

/** Marketing-maandtargets (null = niet ingesteld). */
export function marketingTargets(cfg) {
  const m = (cfg && cfg.marketing) || {};
  const n = (v) => (Number.isFinite(v) && v > 0 ? v : null);
  return {
    omzetMaand: n(m.omzetMaand),       /* € netto-omzet/maand */
    poasMin: n(m.poasMin),             /* minimale POAS */
    roasMin: n(m.roasMin),             /* minimale ROAS */
    volgersMaand: n(m.volgersMaand),   /* nieuwe IG-volgers/maand */
    adBudgetMaand: n(m.adBudgetMaand)  /* € advertentiebudget/maand */
  };
}

/** Gala-Instagram-config met defaults. accounts = lijst publieke IG-usernames. */
export function galaInstagramConfig(cfg) {
  const g = (cfg && cfg.gala) || {};
  return {
    instagramAccounts: Array.isArray(g.instagramAccounts) ? g.instagramAccounts : [],
    instagramEnabled: g.instagramEnabled === true
  };
}

/** Omzet-anomalie-config met defaults. */
export function anomalyAlertConfig(cfg) {
  const a = (cfg && cfg.anomaly) || {};
  return {
    enabled: a.enabled !== false,
    thresholdPct: Number.isFinite(a.thresholdPct) ? a.thresholdPct : 25,
    windowDays: Number.isFinite(a.windowDays) ? a.windowDays : 7
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
    const next = { inkoop: { ...(d.inkoop || {}) }, hr: { ...(d.hr || {}) }, notify: { ...(d.notify || {}) }, merchandiser: { ...(d.merchandiser || {}) }, forecast: { ...(d.forecast || {}) }, anomaly: { ...(d.anomaly || {}) }, gala: { ...(d.gala || {}) }, marketing: { ...(d.marketing || {}) } };

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
    if (patch.forecast) {
      const p = patch.forecast;
      if (p.groeitargetPct !== undefined) next.forecast.groeitargetPct = asNum(p.groeitargetPct, 0);
    }
    if (patch.anomaly) {
      const p = patch.anomaly;
      if (p.enabled !== undefined) next.anomaly.enabled = Boolean(p.enabled);
      if (p.thresholdPct !== undefined) next.anomaly.thresholdPct = Math.max(1, Math.round(asNum(p.thresholdPct, 25)));
      if (p.windowDays !== undefined) next.anomaly.windowDays = Math.max(1, Math.min(31, Math.round(asNum(p.windowDays, 7))));
    }
    if (patch.marketing) {
      const p = patch.marketing;
      for (const k of ['omzetMaand', 'poasMin', 'roasMin', 'volgersMaand', 'adBudgetMaand']) {
        if (p[k] !== undefined) {
          const v = asNum(p[k], NaN);
          if (!Number.isFinite(v) || v <= 0) delete next.marketing[k]; /* leeg/0 = doel wissen */
          else next.marketing[k] = v;
        }
      }
    }
    if (patch.gala) {
      const p = patch.gala;
      if (p.instagramAccounts !== undefined) {
        /* Normaliseer naar kale usernames: strip @, spaties en eventuele
           instagram.com/<naam>-URL's zodat de Graph-API ze accepteert. */
        next.gala.instagramAccounts = asList(p.instagramAccounts).map((s) =>
          s.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/[/?].*$/, '').replace(/^@/, '').trim()
        ).filter(Boolean);
      }
      if (p.instagramEnabled !== undefined) next.gala.instagramEnabled = Boolean(p.instagramEnabled);
    }
    next.updatedAt = new Date().toISOString();
    next.updatedBy = clean(actor) || 'admin';
    return next;
  }, { fallback: { ...EMPTY } });
  return readPortalConfig();
}
