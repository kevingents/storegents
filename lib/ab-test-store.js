/**
 * lib/ab-test-store.js
 *
 * A/B-tests op nieuwsbrief-onderwerpen. Een test stuurt onderwerp A naar een
 * deterministische steekproef (op hash van het e-mailadres) en onderwerp B naar
 * een tweede even grote steekproef; opens worden per variant geteld via de
 * Resend-webhook (tags abtest/abvariant). Daarna gaat het winnende onderwerp naar
 * de rest van de audience.
 *
 * Blob: marketing/ab-tests.json
 */

import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/ab-tests.json';
const clean = (v) => String(v == null ? '' : v).trim();

export async function listAbTests() {
  const l = await readJsonBlob(PATH, []).catch(() => []);
  return Array.isArray(l) ? l : [];
}
async function writeAll(list) { await writeJsonBlob(PATH, list); }

export async function getAbTest(id) { return (await listAbTests()).find((t) => t.id === id) || null; }
export async function getAbTestByNewsletter(newsletterId) {
  const list = await listAbTests();
  return list.filter((t) => t.newsletterId === newsletterId).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))[0] || null;
}

export async function createAbTest({ newsletterId, subjectA, subjectB, samplePct }) {
  const list = await listAbTests();
  const pct = Math.max(5, Math.min(40, Number(samplePct) || 15));
  const obj = {
    id: 'ab-' + Math.random().toString(36).slice(2, 9),
    newsletterId,
    subjectA: clean(subjectA).slice(0, 160),
    subjectB: clean(subjectB).slice(0, 160),
    samplePct: pct,
    status: 'testing',           // testing → decided → done
    opens: { A: 0, B: 0 },
    sentCounts: { A: 0, B: 0, remainder: 0 },
    remainderCursorPage: 1,
    winner: null,
    startedAt: new Date().toISOString(),
    decidedAt: null
  };
  list.push(obj);
  await writeAll(list);
  return obj;
}

export async function patchAbTest(id, patch) {
  const list = await listAbTests();
  const i = list.findIndex((t) => t.id === id);
  if (i < 0) return null;
  list[i] = { ...list[i], ...patch };
  await writeAll(list);
  return list[i];
}

export async function deleteAbTest(id) { await writeAll((await listAbTests()).filter((t) => t.id !== id)); return true; }

/* Aangeroepen vanuit de Resend-webhook bij email.opened met onze A/B-tags. */
export async function recordAbOpen(testId, variant) {
  const v = variant === 'B' ? 'B' : 'A';
  const list = await listAbTests();
  const i = list.findIndex((t) => t.id === testId);
  if (i < 0) return false;
  list[i].opens = list[i].opens || { A: 0, B: 0 };
  list[i].opens[v] = (list[i].opens[v] || 0) + 1;
  await writeAll(list);
  return true;
}

/* Deterministische bucket op e-mail: 0..99. */
export function emailBucket(email) {
  const s = String(email || '').toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h % 100;
}

/* Variant voor een e-mail bij gegeven samplePct: 'A' | 'B' | 'remainder'. */
export function variantFor(email, samplePct) {
  const b = emailBucket(email);
  if (b < samplePct) return 'A';
  if (b < samplePct * 2) return 'B';
  return 'remainder';
}
