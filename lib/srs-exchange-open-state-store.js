import { list, put } from '@vercel/blob';

const STORE_KEY = 'srs-exchanges/open-exchange-state.json';

function nowIso() {
  return new Date().toISOString();
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

async function readState() {
  try {
    const result = await list({ prefix: STORE_KEY, limit: 1 });
    const blob = (result.blobs || []).find((item) => item.pathname === STORE_KEY) || result.blobs?.[0];

    if (!blob?.url) return { exchanges: {} };

    const response = await fetch(blob.url, { cache: 'no-store' });
    if (!response.ok) return { exchanges: {} };

    const text = await response.text();
    return safeJson(text, { exchanges: {} });
  } catch (error) {
    console.error('Read SRS exchange state error:', error);
    return { exchanges: {} };
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
    String(exchange.uitwisselingId || '').trim(),
    String(exchange.vanFiliaal || '').trim(),
    String(exchange.naarFiliaal || '').trim()
  ].join('::');
}

function validIso(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function daysOpenSince(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 0;
  const diffMs = Date.now() - date.getTime();
  return Math.max(0, Math.floor(diffMs / (24 * 60 * 60 * 1000)));
}

export async function enrichOpenExchangeState(exchanges = []) {
  const state = await readState();
  const current = state.exchanges || {};
  const seenNow = nowIso();
  const activeKeys = new Set();

  const enriched = exchanges.map((exchange) => {
    const key = exchangeKey(exchange);
    activeKeys.add(key);

    const srsCreatedAt = validIso(
      exchange.createdAt ||
      exchange.dateTime ||
      exchange.aangemaaktOp ||
      exchange.created ||
      ''
    );

    const previous = current[key] || {};
    const firstSeenAt = previous.firstSeenAt || srsCreatedAt || seenNow;
    const openSince = srsCreatedAt || firstSeenAt;
    const openDays = daysOpenSince(openSince);

    current[key] = {
      key,
      uitwisselingId: exchange.uitwisselingId || '',
      vanFiliaal: exchange.vanFiliaal || '',
      naarFiliaal: exchange.naarFiliaal || '',
      firstSeenAt,
      srsCreatedAt,
      openSince,
      lastSeenAt: seenNow,
      closedAt: '',
      status: 'open'
    };

    return {
      ...exchange,
      key,
      firstSeenAt,
      srsCreatedAt,
      openSince,
      openDays,
      isOverdue: openDays >= 7,
      openDateSource: srsCreatedAt ? 'srs' : 'first_seen'
    };
  });

  for (const [key, value] of Object.entries(current)) {
    if (!activeKeys.has(key) && value.status === 'open') {
      current[key] = {
        ...value,
        status: 'closed_or_processed',
        closedAt: seenNow
      };
    }
  }

  await writeState({
    updatedAt: seenNow,
    exchanges: current
  });

  return enriched;
}
