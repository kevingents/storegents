/**
 * GENTS — Verzend-cutoff config (per kanaal: winkel + online)
 * ==========================================================
 *
 * Blob-backed override van de verzend-deadline-instellingen die de business
 * zonder developer kan aanpassen (admin-instellingen). Code-level defaults
 * staan hieronder; de blob bevat alleen de overrides.
 *
 * Gebruikt door lib/ship-deadline.js (computeShipDeadline / isShipOverdue) en
 * de Te-late-orders KPI's (winkel + online apart).
 *
 * Blob-shape (config/order-cutoff-config.json):
 *   { winkel: { shipByWorkingDays, cutoffHour, cutoffMinute },
 *     online: { ... }, updatedAt }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_KEY = 'config/order-cutoff-config.json';

/** Code-level defaults (fallback als er geen blob-override is). */
export const DEFAULT_CUTOFF_CONFIG = Object.freeze({
  winkel: Object.freeze({ shipByWorkingDays: 1, cutoffHour: 14, cutoffMinute: 0 }),
  online: Object.freeze({ shipByWorkingDays: 1, cutoffHour: 14, cutoffMinute: 0 })
});

function clampChannel(channel = {}, def) {
  return {
    shipByWorkingDays: Math.max(1, Math.min(20, Number(channel.shipByWorkingDays ?? def.shipByWorkingDays) || def.shipByWorkingDays)),
    cutoffHour: Math.max(0, Math.min(23, Number(channel.cutoffHour ?? def.cutoffHour))),
    cutoffMinute: Math.max(0, Math.min(59, Number(channel.cutoffMinute ?? def.cutoffMinute)))
  };
}

/** Lees de effectieve config (defaults + blob-override, geclampd). */
export async function getShipCutoffConfig() {
  let stored = {};
  try {
    stored = await readJsonBlob(STORE_KEY, {}) || {};
  } catch (error) {
    /* Corrupte/onleesbare blob → val terug op defaults i.p.v. crashen, maar log. */
    console.error('[order-cutoff-config-store] read error:', error.message);
    stored = {};
  }
  return {
    winkel: clampChannel(stored.winkel || {}, DEFAULT_CUTOFF_CONFIG.winkel),
    online: clampChannel(stored.online || {}, DEFAULT_CUTOFF_CONFIG.online),
    updatedAt: stored.updatedAt || null
  };
}

/** Sla een (gedeeltelijke) update op; ontbrekende velden behouden hun waarde. */
export async function saveShipCutoffConfig(partial = {}) {
  const current = await getShipCutoffConfig();
  const next = {
    winkel: clampChannel({ ...current.winkel, ...(partial.winkel || {}) }, DEFAULT_CUTOFF_CONFIG.winkel),
    online: clampChannel({ ...current.online, ...(partial.online || {}) }, DEFAULT_CUTOFF_CONFIG.online),
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(STORE_KEY, next);
  return next;
}

/** Map een vrij kanaal-veld ('online'/'webshop'/'web' → online, anders winkel). */
export function channelKeyOf(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('online') || v.includes('web') || v.includes('shop')) return 'online';
  return 'winkel';
}

/** Convenience: haal de config voor één kanaal op. */
export async function getCutoffForChannel(channel) {
  const cfg = await getShipCutoffConfig();
  return cfg[channelKeyOf(channel)] || cfg.winkel;
}
