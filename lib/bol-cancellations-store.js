/**
 * lib/bol-cancellations-store.js
 *
 * Idempotency + history voor bol-order annuleringen.
 *
 * Blob: marketplace/bol-cancellations.json
 *   {
 *     cancelled: {
 *       "<bolOrderId>": {
 *         bolOrderId, srsOrderId, reasonCode, reasonText, items,
 *         cancelledAt, cancelledBy, bolProcessId, srsNotified
 *       }
 *     },
 *     updatedAt
 *   }
 *
 * Een geannuleerde order verschijnt niet meer in de bol-orders sync (slaat 'm
 * over) en de bol-shipment-push laat 'm vallen — alles via 1 lookup hier.
 */

import { readJsonBlob, mutateJsonBlob } from './json-blob-store.js';

const STORE_PATH = 'marketplace/bol-cancellations.json';
const clean = (v) => String(v == null ? '' : v).trim();

export async function readBolCancellationsState() {
  const data = await readJsonBlob(STORE_PATH, null).catch(() => null);
  if (data && typeof data === 'object' && data.cancelled && typeof data.cancelled === 'object') return data;
  return { cancelled: {}, updatedAt: null };
}

export async function isBolOrderCancelled(bolOrderId) {
  const id = clean(bolOrderId);
  if (!id) return false;
  const state = await readBolCancellationsState();
  return !!state.cancelled[id];
}

export async function recordBolCancellation(bolOrderId, info = {}) {
  const id = clean(bolOrderId);
  if (!id) return;
  await mutateJsonBlob(STORE_PATH, (cur) => {
    const data = (cur && typeof cur === 'object' && cur.cancelled && typeof cur.cancelled === 'object')
      ? { cancelled: { ...cur.cancelled } }
      : { cancelled: {} };
    data.cancelled[id] = {
      bolOrderId: id,
      srsOrderId: clean(info.srsOrderId),
      reasonCode: clean(info.reasonCode) || 'OUT_OF_STOCK',
      reasonText: clean(info.reasonText),
      items: Array.isArray(info.items) ? info.items : [],
      cancelledAt: info.cancelledAt || new Date().toISOString(),
      cancelledBy: clean(info.cancelledBy) || 'system',
      bolProcessId: clean(info.bolProcessId),
      srsNotified: !!info.srsNotified,
      ...(info.error ? { error: clean(info.error).slice(0, 500) } : {})
    };
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { cancelled: {} } });
}

export async function readBolCancellationsStats() {
  const state = await readBolCancellationsState();
  const list = Object.values(state.cancelled || {});
  const byReason = {};
  for (const c of list) {
    const r = c.reasonCode || 'UNKNOWN';
    byReason[r] = (byReason[r] || 0) + 1;
  }
  return {
    total: list.length,
    byReason,
    last10: list.sort((a, b) => String(b.cancelledAt || '').localeCompare(String(a.cancelledAt || ''))).slice(0, 10)
  };
}
