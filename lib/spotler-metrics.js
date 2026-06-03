/**
 * Spotler e-mailmarketing metrics.
 *
 * Haalt recente mailings op (GET /mailing) en per mailing de statistieken
 * (GET /mailing/{encryptedMailingId}/statistics), berekent per-mailing rates
 * en totalen, en cachet het resultaat in een Blob. De zware fetch draait via
 * de dagelijkse cron; de UI leest de cache.
 *
 * Veldnamen volgen de MailPlus REST API (MailingStats): sentCount,
 * acceptedCount (afgeleverd), openCount, clickCount, hardbounceCount,
 * softbounceCount, unsubscribeCount, conversionValue.
 */

import { spotlerRequest, hasSpotlerCreds } from './spotler-client.js';
import { readJsonBlob, writeJsonBlob } from './json-blob-store.js';

const PATH = 'marketing/spotler-metrics.json';
const MAX_MAILINGS = 24;          // begrens het aantal stat-calls per run (rate-limit hygiene)
const LOOKBACK_DAYS = 180;
/* truncated wordt naar de cache geschreven zodra MAX_MAILINGS overschreden is,
   zodat de UI kan tonen "tot 24 mailings (recent)" i.p.v. te suggereren dat
   het complete beeld is voor 180 dagen. */

const num = (v) => (Number(v) || 0);
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0); // 1 decimaal

/* Respons kan een array zijn of een object met een array-property. */
function asArray(d) {
  if (Array.isArray(d)) return d;
  if (d && typeof d === 'object') {
    for (const k of ['mailings', 'mailing', 'items', 'data', 'results', 'list', 'content']) {
      if (Array.isArray(d[k])) return d[k];
    }
    for (const v of Object.values(d)) if (Array.isArray(v)) return v;
  }
  return [];
}

function mapStats(raw) {
  const st = (raw && typeof raw === 'object' && raw.statistics && typeof raw.statistics === 'object') ? raw.statistics : (raw || {});
  const sent = num(st.sentCount);
  const delivered = num(st.acceptedCount);
  const opens = num(st.openCount);
  const clicks = num(st.clickCount);
  const hard = num(st.hardbounceCount);
  const soft = num(st.softbounceCount);
  const unsub = num(st.unsubscribeCount);
  const denom = delivered || sent;
  return {
    sent, delivered, opens, clicks, unsub,
    hardbounce: hard, softbounce: soft, bounces: hard + soft,
    conversionValue: num(st.conversionValue),
    openRate: pct(opens, denom),
    ctr: pct(clicks, denom),
    bounceRate: pct(hard + soft, sent),
    unsubRate: pct(unsub, denom)
  };
}

/**
 * Volledige refresh: fetch + bereken + schrijf cache. Retourneert het object.
 */
export async function refreshSpotlerMetrics() {
  if (!hasSpotlerCreds()) {
    return { connected: false, rows: [], totals: null, refreshedAt: new Date().toISOString() };
  }

  /* /mailing vereist fromDate ÉN toDate. Doc zegt ISO 8601; sommige instances
     willen epoch-millis. Probeer ISO (zonder ms), val terug op epoch bij een
     datum-fout. */
  const since = Date.now() - LOOKBACK_DAYS * 86400000;
  const until = Date.now() + 86400000; /* +1 dag marge zodat vandaag meetelt */
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  let list;
  try {
    list = await spotlerRequest('GET', 'mailing', { query: { fromDate: iso(since), toDate: iso(until), pageSize: '100' } });
  } catch (e) {
    if (/from ?date|to ?date|invalid.*date/i.test(e.message || '')) {
      list = await spotlerRequest('GET', 'mailing', { query: { fromDate: String(since), toDate: String(until), pageSize: '100' } });
    } else throw e;
  }

  const mailings = asArray(list)
    .filter((m) => !m.type || String(m.type).toUpperCase() === 'EMAIL')
    .map((m) => ({
      id: String(m.encryptedId || m.encryptedMailingId || m.id || ''),
      name: m.name || '—',
      date: m.scheduledStartDate || m.sendDate || m.date || '',
      type: m.type || 'EMAIL',
      sent: num(m.sentCount)
    }))
    .filter((m) => m.id)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)))
    .slice(0, MAX_MAILINGS);

  const rows = [];
  for (const m of mailings) {
    try {
      const stats = await spotlerRequest('GET', `mailing/${encodeURIComponent(m.id)}/statistics`);
      rows.push({ ...m, ...mapStats(stats) });
    } catch (e) {
      rows.push({ ...m, error: e.message, delivered: 0, opens: 0, clicks: 0, bounces: 0, unsub: 0, openRate: 0, ctr: 0, bounceRate: 0, unsubRate: 0 });
    }
  }

  const sum = (k) => rows.reduce((a, r) => a + num(r[k]), 0);
  const totSent = sum('sent');
  const totDeliv = sum('delivered') || totSent;
  const totals = {
    mailings: rows.length,
    sent: totSent,
    delivered: sum('delivered'),
    opens: sum('opens'),
    clicks: sum('clicks'),
    bounces: sum('bounces'),
    unsub: sum('unsub'),
    conversionValue: Math.round(sum('conversionValue') * 100) / 100,
    openRate: pct(sum('opens'), totDeliv),
    ctr: pct(sum('clicks'), totDeliv),
    bounceRate: pct(sum('bounces'), totSent),
    unsubRate: pct(sum('unsub'), totDeliv)
  };

  const data = { connected: true, rows, totals, refreshedAt: new Date().toISOString() };
  try { await writeJsonBlob(PATH, data); } catch (_) { /* cache best-effort */ }
  return data;
}

export async function readSpotlerMetrics() {
  return readJsonBlob(PATH, null);
}
