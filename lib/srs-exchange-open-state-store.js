import { list, put } from '@vercel/blob';
import { parseSrsDateTime } from './srs-exchanges-client.js';

const STORE_KEY = 'srs-exchanges/open-exchange-state.json';
const STATE_VERSION = 3;

function nowIso() { return new Date().toISOString(); }

function safeJson(value, fallback) {
  try { return JSON.parse(value); } catch (_error) { return fallback; }
}

async function readState() {
  try {
    const result = await list({ prefix: STORE_KEY, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === STORE_KEY) || result.blobs?.[0];
    if (!blob?.url) return { version: STATE_VERSION, exchanges: {} };
    const response = await fetch(blob.url, { cache: 'no-store' });
    if (!response.ok) return { version: STATE_VERSION, exchanges: {} };
    const text = await response.text();
    return safeJson(text, { version: STATE_VERSION, exchanges: {} });
  } catch (error) {
    console.error('Read SRS exchange state error:', error);
    return { version: STATE_VERSION, exchanges: {} };
  }
}

async function writeState(state) {
  await put(STORE_KEY, JSON.stringify(state, null, 2), {
    access: 'public',
    contentType: 'application/json',
    allowOverwrite: true,
    cacheControlMaxAge: 60
  });
}

function exchangeKey(exchange) {
  return [
    String(exchange.uitwisselingId || exchange.exchangeId || '').trim(),
    String(exchange.vanFiliaal || exchange.fromBranchId || '').trim(),
    String(exchange.naarFiliaal || exchange.toBranchId || '').trim()
  ].join('::');
}

function validIso(value) {
  if (!value) return '';
  const date = parseSrsDateTime(value);
  if (!date || Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function daysOpenSince(value) {
  const date = parseSrsDateTime(value);
  if (!date || Number.isNaN(date.getTime())) return 0;
  return Math.max(0, Math.floor((Date.now() - date.getTime()) / (24 * 60 * 60 * 1000)));
}

function resolveSrsCreatedAt(exchange) {
  return validIso(exchange.srsCreatedAt || exchange.createdAt || exchange.dateTime || exchange.aangemaaktOp || exchange.createdAtRaw || exchange.created || '');
}

function resolveFirstDetectedAt(previous, seenNow) {
  if (previous?.firstDetectedAt) return previous.firstDetectedAt;
  if (previous?.detectedAt) return previous.detectedAt;
  if (previous?.firstSeenAt) return previous.firstSeenAt;
  return seenNow;
}

function resolveSeller(exchange, previous = {}) {
  return exchange.verkoper || exchange.sellerName || exchange.seller || exchange.createdBy || exchange.aangemaaktDoor || previous.verkoper || previous.sellerName || '';
}

export async function enrichOpenExchangeState(exchanges = []) {
  const state = await readState();
  const current = state.exchanges || {};
  const seenNow = nowIso();
  const activeKeys = new Set();

  const enriched = exchanges.map((exchange) => {
    const key = exchangeKey(exchange);
    activeKeys.add(key);
    const previous = current[key] || {};
    const srsCreatedAt = resolveSrsCreatedAt(exchange);
    const firstDetectedAt = resolveFirstDetectedAt(previous, seenNow);
    const openSince = srsCreatedAt || firstDetectedAt;
    const openDays = daysOpenSince(openSince);
    const sellerName = resolveSeller(exchange, previous);
    const isNew = !previous.firstDetectedAt && !previous.detectedAt && !previous.firstSeenAt && !previous.lastSeenAt;

    current[key] = {
      key,
      uitwisselingId: exchange.uitwisselingId || exchange.exchangeId || '',
      vanFiliaal: exchange.vanFiliaal || exchange.fromBranchId || '',
      naarFiliaal: exchange.naarFiliaal || exchange.toBranchId || '',
      verkoper: sellerName,
      sellerName,
      firstDetectedAt,
      firstSeenAt: firstDetectedAt,
      detectedAt: firstDetectedAt,
      srsCreatedAt,
      openSince,
      lastSeenAt: seenNow,
      closedAt: '',
      status: 'open'
    };

    return {
      ...exchange,
      key,
      verkoper: sellerName,
      sellerName,
      createdBy: sellerName,
      createdAt: openSince,
      dateTime: openSince,
      aangemaaktOp: openSince,
      firstDetectedAt,
      firstSeenAt: firstDetectedAt,
      detectedAt: firstDetectedAt,
      srsCreatedAt,
      openSince,
      openDays,
      isNew,
      isOverdue: openDays >= 7,
      openDateSource: srsCreatedAt ? 'srs' : 'first_detected_daily_sync'
    };
  });

  for (const [key, value] of Object.entries(current)) {
    if (!activeKeys.has(key) && value.status === 'open') {
      current[key] = { ...value, status: 'closed_or_processed', closedAt: seenNow };
    }
  }

  await writeState({ version: STATE_VERSION, updatedAt: seenNow, exchanges: current });
  return enriched;
}
