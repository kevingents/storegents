/**
 * lib/bol-order-counter.js
 *
 * Sequentieel ordernummer-generator voor Bol-marketplace orders die naar SRS
 * gepushed worden. Formaat: BOL-0001, BOL-0002, ...
 *
 * Blob: marketplace/bol-order-counter.json
 *   { lastNumber: 12, updatedAt: "...", history: [{ at, orderId, bolOrderId }] }
 *
 * Atomic increment via mutateJsonBlob (optimistic-concurrency). Geen dubbele
 * nummers mogelijk, ook bij concurrent cron-runs.
 */

import { mutateJsonBlob, readJsonBlob } from './json-blob-store.js';

const PATH = 'marketplace/bol-order-counter.json';
const PREFIX = 'BOL-';
const PAD = 4;
const MAX_HISTORY = 200;

function pad(n) {
  return String(n).padStart(PAD, '0');
}

function formatId(n) {
  return `${PREFIX}${pad(n)}`;
}

export function parseBolOrderId(s) {
  const m = String(s || '').match(/^BOL-(\d+)$/i);
  return m ? Number(m[1]) : 0;
}

/** Volgende ordernummer + log het direct in de history (atomic). */
export async function reserveNextBolOrderId({ bolOrderId = '', actor = 'cron' } = {}) {
  let issued = null;
  await mutateJsonBlob(PATH, (cur) => {
    const data = (cur && typeof cur === 'object')
      ? { lastNumber: Number(cur.lastNumber) || 0, history: Array.isArray(cur.history) ? [...cur.history] : [] }
      : { lastNumber: 0, history: [] };
    const next = data.lastNumber + 1;
    issued = formatId(next);
    data.lastNumber = next;
    data.history.unshift({
      at: new Date().toISOString(),
      orderId: issued,
      bolOrderId: String(bolOrderId || ''),
      actor: String(actor || '')
    });
    if (data.history.length > MAX_HISTORY) data.history.length = MAX_HISTORY;
    data.updatedAt = new Date().toISOString();
    return data;
  }, { fallback: { lastNumber: 0, history: [] } });
  return issued;
}

/** Read-only: huidige stand + recente history. */
export async function readBolOrderCounter() {
  const data = await readJsonBlob(PATH, { lastNumber: 0, history: [] }).catch(() => ({ lastNumber: 0, history: [] }));
  return {
    lastNumber: Number(data?.lastNumber) || 0,
    lastIssued: data?.lastNumber ? formatId(data.lastNumber) : null,
    nextWillBe: formatId((Number(data?.lastNumber) || 0) + 1),
    updatedAt: data?.updatedAt || null,
    history: Array.isArray(data?.history) ? data.history.slice(0, 50) : []
  };
}
