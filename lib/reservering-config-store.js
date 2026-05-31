/**
 * GENTS — Reservering-config (instelbare aging-drempel)
 * =====================================================
 *
 * Blob-backed override van de "te lang in reservering"-drempel. Bedrijf kan dit
 * zonder developer aanpassen via Instellingen. Drijft de aging-markering op de
 * (read-only) Reserveringen-weergave.
 *
 * Blob: config/reservering-config.json  →  { agingDagen, updatedAt }
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const STORE_KEY = 'config/reservering-config.json';

export const DEFAULT_RESERVERING_CONFIG = Object.freeze({ agingDagen: 7 });

function clampDays(d) {
  const n = Number(d);
  return Number.isFinite(n) ? Math.max(1, Math.min(365, Math.round(n))) : DEFAULT_RESERVERING_CONFIG.agingDagen;
}

export async function getReserveringConfig() {
  let stored = {};
  try {
    stored = await readJsonBlob(STORE_KEY, {}) || {};
  } catch (error) {
    console.error('[reservering-config-store] read error:', error.message);
    stored = {};
  }
  return {
    agingDagen: clampDays(stored.agingDagen ?? DEFAULT_RESERVERING_CONFIG.agingDagen),
    updatedAt: stored.updatedAt || null
  };
}

export async function saveReserveringConfig(partial = {}) {
  const current = await getReserveringConfig();
  const next = {
    agingDagen: clampDays(partial.agingDagen ?? current.agingDagen),
    updatedAt: new Date().toISOString()
  };
  await writeJsonBlob(STORE_KEY, next);
  return next;
}
