#!/usr/bin/env node
/**
 * Direct-blob versie van audit-mail-logs.js.
 * Leest de Vercel Blob direct (mail-automations/gents-mail-log.json) ipv
 * via /api/admin/mail-log. Vereist BLOB_READ_WRITE_TOKEN env-var.
 *
 * Gebruik:
 *   BLOB_READ_WRITE_TOKEN=vercel_blob_rw_... node scripts/audit-mail-logs-direct.js [--days=30]
 */

import process from 'node:process';
import { list } from '@vercel/blob';

const TOKEN = String(process.env.BLOB_READ_WRITE_TOKEN || '').trim();
if (!TOKEN) {
  console.error('FOUT: BLOB_READ_WRITE_TOKEN env-var ontbreekt.');
  process.exit(1);
}

const args = process.argv.slice(2);
function argVal(name, def) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const DAYS = Math.max(1, Math.min(180, Number(argVal('days', 30))));
const BLOB_PATH = String(argVal('path', 'mail-automations/gents-mail-log.json'));
const PRINT_JSON = args.includes('--json');

const ALL_STORES = [
  'GENTS Almere', 'GENTS Amersfoort', 'GENTS Amsterdam', 'GENTS Antwerpen',
  'GENTS Arnhem', 'GENTS Breda', 'GENTS Delft', 'GENTS Den Bosch',
  'GENTS Enschede', 'GENTS Groningen', 'GENTS Hilversum', 'GENTS Leiden',
  'GENTS Maastricht', 'GENTS Nijmegen', 'GENTS Rotterdam', 'GENTS Tilburg',
  'GENTS Utrecht', 'GENTS Zoetermeer', 'GENTS Zwolle', 'Suitconcer'
];
const EXCLUDED_FROM_STORE_MAIL = new Set([
  'GENTS Magazijn', 'GENTS Magazijn (Uitlevertafel)', 'GENTS Showroom',
  'Suitconcer Magazijn'
]);

function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) { const d = new Date(); d.setUTCDate(d.getUTCDate() - n); return d; }

async function readMailLog() {
  const result = await list({ prefix: BLOB_PATH, limit: 1, token: TOKEN });
  const blob = (result.blobs || []).find((b) => b.pathname === BLOB_PATH);
  if (!blob) {
    console.error(`Blob niet gevonden: ${BLOB_PATH}`);
    return [];
  }
  const r = await fetch(blob.url);
  if (!r.ok) throw new Error(`Blob fetch HTTP ${r.status}`);
  const txt = await r.text();
  const parsed = JSON.parse(txt || '[]');
  return Array.isArray(parsed) ? parsed : [];
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const item of arr) { const k = fn(item); if (!m.has(k)) m.set(k, []); m.get(k).push(item); }
  return m;
}
function topN(map, n = 10) {
  return [...map.entries()].map(([k, v]) => ({ key: k, count: v.length, samples: v.slice(0, 3) }))
    .sort((a, b) => b.count - a.count).slice(0, n);
}

function analyze(rows) {
  const errors = rows.filter((r) => r.status === 'error');
  const sent = rows.filter((r) => r.status === 'sent' || r.status === 'success');
  const errorsByType = groupBy(errors, (r) => r.type || '(geen type)');
  const errorsByMessage = groupBy(errors, (r) => {
    const m = String(r.error || r.message || '(geen melding)').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return m.slice(0, 120);
  });
  const errorsByStore = groupBy(errors, (r) => r.store || '(geen store)');
  const htmlPollution = errors.filter((r) => /<\w+[^>]*>/.test(String(r.error || '')));
  const configErrors = rows.filter((r) => /_config$/.test(r.type || ''));
  const runErrors = rows.filter((r) => /_run_error$/.test(r.type || ''));

  const last7 = daysAgo(7);
  const recentRows = rows.filter((r) => new Date(r.createdAt || r.sentAt || 0) >= last7);
  const storesWithMail = new Set(recentRows.filter((r) => r.status === 'sent' || r.status === 'success').map((r) => r.store).filter(Boolean));
  const storesWithoutMail7d = ALL_STORES.filter((s) => !EXCLUDED_FROM_STORE_MAIL.has(s)).filter((s) => !storesWithMail.has(s));

  const storeMailTypes = [
    'pickup_new_store', 'pickup_not_ready_reminder',
    'weborder_overdue_store',
    'customer_weekly_store', 'customer_monthly_store'
  ];
  const missingPerType = {};
  for (const t of storeMailTypes) {
    const storesForType = new Set(
      recentRows.filter((r) => r.type === t && (r.status === 'sent' || r.status === 'success')).map((r) => r.store)
    );
    missingPerType[t] = ALL_STORES.filter((s) => !EXCLUDED_FROM_STORE_MAIL.has(s)).filter((s) => !storesForType.has(s));
  }

  const resendIssues = {
    rateLimit: errors.filter((r) => /rate.?limit|too many/i.test(String(r.error || ''))).length,
    authFail: errors.filter((r) => /unauthor|invalid.?api.?key|401/i.test(String(r.error || ''))).length,
    bounced: errors.filter((r) => /bounce|invalid.?recipient|undeliverable/i.test(String(r.error || ''))).length,
    timeout: errors.filter((r) => /timeout|aborted|econn|enotfound/i.test(String(r.error || ''))).length
  };

  const storesNoEmail = new Set(configErrors.map((r) => r.store).filter(Boolean));

  return {
    totaal: rows.length, verzonden: sent.length, errors: errors.length,
    successRate: rows.length ? (sent.length / rows.length * 100).toFixed(1) + '%' : '–',
    topErrorTypes: topN(errorsByType, 10),
    topErrorMessages: topN(errorsByMessage, 12),
    topErrorStores: topN(errorsByStore, 15),
    htmlPollution: htmlPollution.length,
    htmlPollutionSamples: htmlPollution.slice(0, 3).map((r) => ({ type: r.type, store: r.store, errorPrefix: String(r.error || '').slice(0, 80) })),
    configErrors: configErrors.length,
    storesNoEmail: [...storesNoEmail],
    runErrors: runErrors.length,
    runErrorSamples: runErrors.slice(0, 8).map((r) => ({ type: r.type, store: r.store, error: String(r.error || '').slice(0, 250), at: r.createdAt })),
    storesWithoutAnyMail7d: storesWithoutMail7d,
    missingPerType, resendIssues,
    /* Extra: laatste 20 errors voor debug */
    recentErrors: errors.slice(0, 20).map((r) => ({
      at: r.createdAt, type: r.type, store: r.store, to: r.to || r.recipient,
      error: String(r.error || '').slice(0, 200)
    })),
    /* Datum-range van data */
    earliestEntry: rows.length ? rows[rows.length - 1]?.createdAt : null,
    latestEntry: rows.length ? rows[0]?.createdAt : null
  };
}

function printReport(report, dateFrom, dateTo) {
  const line = '─'.repeat(72);
  console.log(`\n${line}\n  MAIL-LOG AUDIT  ·  filter ${dateFrom} → ${dateTo}\n${line}\n`);
  console.log(`Data-range:        ${report.earliestEntry?.slice(0,10)} → ${report.latestEntry?.slice(0,10)}`);
  console.log(`Totaal entries:    ${report.totaal}`);
  console.log(`Verzonden (sent):  ${report.verzonden}`);
  console.log(`Errors:            ${report.errors}`);
  console.log(`Success-rate:      ${report.successRate}\n`);

  console.log('── 1. ERRORS PER TYPE ───────────────────────────────────────────────');
  if (!report.topErrorTypes.length) console.log('   (geen errors)');
  for (const e of report.topErrorTypes) console.log(`   ${String(e.count).padStart(5)}  ${e.key}`);
  console.log('');

  console.log('── 2. ERRORS PER STORE ──────────────────────────────────────────────');
  if (!report.topErrorStores.length) console.log('   (geen errors)');
  for (const e of report.topErrorStores) console.log(`   ${String(e.count).padStart(5)}  ${e.key}`);
  console.log('');

  console.log('── 3. ERRORS PER FOUTMELDING ─────────────────────────────────────────');
  if (!report.topErrorMessages.length) console.log('   (geen errors)');
  for (const e of report.topErrorMessages) console.log(`   ${String(e.count).padStart(5)}  ${e.key}`);
  console.log('');

  console.log('── 4. RESEND-PATRONEN ───────────────────────────────────────────────');
  console.log(`   Rate-limit hits:   ${report.resendIssues.rateLimit}`);
  console.log(`   Auth-fouten:       ${report.resendIssues.authFail}`);
  console.log(`   Bounces:           ${report.resendIssues.bounced}`);
  console.log(`   Timeouts:          ${report.resendIssues.timeout}\n`);

  console.log('── 5. CONFIG- + RUN-ERRORS ──────────────────────────────────────────');
  console.log(`   Config-errors:     ${report.configErrors}`);
  if (report.storesNoEmail.length) {
    console.log(`   Stores zonder e-mail:`);
    for (const s of report.storesNoEmail) console.log(`      · ${s}`);
  }
  console.log(`   Run-errors:        ${report.runErrors}`);
  for (const r of report.runErrorSamples) {
    console.log(`      · [${r.type}] ${r.store || '–'} @ ${r.at}`);
    console.log(`         ${r.error}`);
  }
  console.log('');

  console.log('── 6. HTML-POLLUTION ────────────────────────────────────────────────');
  console.log(`   ${report.htmlPollution} entries met HTML in error-veld`);
  for (const s of report.htmlPollutionSamples) {
    console.log(`      · [${s.type}] ${s.store} — "${s.errorPrefix}..."`);
  }
  console.log('');

  console.log('── 7. STORES ZONDER ENKELE MAIL LAATSTE 7 DAGEN ─────────────────────');
  if (!report.storesWithoutAnyMail7d.length) console.log('   Alle stores hebben minstens 1 mail ontvangen.');
  else for (const s of report.storesWithoutAnyMail7d) console.log(`   ! ${s}`);
  console.log('');

  console.log('── 8. PER CRON-TYPE: STORES MISSEND (laatste 7 dagen) ───────────────');
  for (const [type, stores] of Object.entries(report.missingPerType)) {
    if (!stores.length) console.log(`   ${type}: alle stores OK`);
    else { console.log(`   ${type}: ${stores.length} stores missend:`); for (const s of stores) console.log(`      · ${s}`); }
  }
  console.log('');

  console.log('── 9. LAATSTE 20 ERRORS (chronologisch, nieuwste eerst) ─────────────');
  for (const e of report.recentErrors) {
    console.log(`   ${e.at?.slice(0, 19)}  [${e.type}]  ${e.store || '–'}  → ${e.to || '–'}`);
    console.log(`      ${e.error}`);
  }
  console.log(`\n${line}\n`);
}

(async () => {
  const dateTo = isoDate(new Date());
  const dateFrom = isoDate(daysAgo(DAYS));

  console.log(`Mail-log lezen uit blob: ${BLOB_PATH}`);
  console.log(`Filter periode: ${dateFrom} → ${dateTo}\n`);

  let allRows;
  try { allRows = await readMailLog(); }
  catch (e) { console.error('FOUT bij ophalen blob:', e.message); process.exit(1); }

  if (!allRows.length) { console.log('Mail-log is leeg.'); process.exit(0); }

  /* Filter op datum-range */
  const rows = allRows.filter((r) => {
    const d = String(r.createdAt || r.sentAt || '').slice(0, 10);
    return d >= dateFrom && d <= dateTo;
  });

  console.log(`Totaal in log:     ${allRows.length} entries`);
  console.log(`Binnen periode:    ${rows.length} entries\n`);

  const report = analyze(rows);

  if (PRINT_JSON) console.log(JSON.stringify({ dateFrom, dateTo, ...report }, null, 2));
  else printReport(report, dateFrom, dateTo);
})().catch((e) => { console.error('Onverwachte fout:', e); process.exit(1); });
