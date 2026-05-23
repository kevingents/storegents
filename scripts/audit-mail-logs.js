#!/usr/bin/env node
/**
 * Mail-log audit script
 * =====================
 *
 * Haalt productie mail-logs op via GET /api/admin/mail-log en analyseert:
 *  - Top errors per type, per store, per foutmelding
 *  - Stores die GEEN mail hebben gehad in de laatste X dagen (per cron-type)
 *  - Config-errors (geen mailadres geconfigureerd)
 *  - Run-errors (cron-handler faalde)
 *  - Resend-specifieke fouten (rate-limit, auth, bounced)
 *  - HTML-pollution in error-veld (oude bug)
 *  - Dedupe-issues (zelfde key/store/type binnen korte tijd)
 *
 * Gebruik:
 *   STOREGENTS_URL=https://jouw-app.vercel.app \
 *   ADMIN_TOKEN=jouw-admin-token \
 *   node scripts/audit-mail-logs.js [--days=30]
 *
 * Optioneel:
 *   --days=N        Hoeveel dagen terug analyseren (default 30)
 *   --json          Print volledig JSON-rapport ipv human-readable
 *   --limit=N       Max aantal rows per fetch (default 1000)
 */

import process from 'node:process';

const STOREGENTS_URL = String(process.env.STOREGENTS_URL || '').replace(/\/$/, '');
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || '').trim();

if (!STOREGENTS_URL) {
  console.error('FOUT: STOREGENTS_URL env-var ontbreekt.');
  console.error('Voorbeeld: STOREGENTS_URL=https://storegents.vercel.app ADMIN_TOKEN=12345 node scripts/audit-mail-logs.js');
  process.exit(1);
}
if (!ADMIN_TOKEN) {
  console.error('FOUT: ADMIN_TOKEN env-var ontbreekt.');
  process.exit(1);
}

/* ─────────────────────── CLI args ─────────────────────── */
const args = process.argv.slice(2);
function argVal(name, def) {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
}
const DAYS = Math.max(1, Math.min(180, Number(argVal('days', 30))));
const LIMIT = Math.max(1, Math.min(1000, Number(argVal('limit', 1000))));
const PRINT_JSON = args.includes('--json');

/* ─────────────────────── Branches lijst ─────────────────────── */
/* Hardcoded zodat het script offline tegen lokale repo werkt — moet
   gesynced blijven met lib/branch-metrics.js. */
const ALL_STORES = [
  'GENTS Almere', 'GENTS Amersfoort', 'GENTS Amsterdam', 'GENTS Antwerpen',
  'GENTS Arnhem', 'GENTS Breda', 'GENTS Delft', 'GENTS Den Bosch',
  'GENTS Enschede', 'GENTS Groningen', 'GENTS Hilversum', 'GENTS Leiden',
  'GENTS Maastricht', 'GENTS Nijmegen', 'GENTS Rotterdam', 'GENTS Tilburg',
  'GENTS Utrecht', 'GENTS Zoetermeer', 'GENTS Zwolle', 'Suitconcer'
];
/* Stores die GEEN winkel-mails zouden moeten krijgen (magazijn/showroom). */
const EXCLUDED_FROM_STORE_MAIL = new Set([
  'GENTS Magazijn', 'GENTS Magazijn (Uitlevertafel)', 'GENTS Showroom',
  'Suitconcer Magazijn'
]);

/* ─────────────────────── Helpers ─────────────────────── */
function isoDate(d) { return d.toISOString().slice(0, 10); }
function daysAgo(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

async function fetchLogs(dateFrom, dateTo) {
  const url = `${STOREGENTS_URL}/api/admin/mail-log?dateFrom=${dateFrom}&dateTo=${dateTo}&limit=${LIMIT}`;
  const r = await fetch(url, { headers: { 'x-admin-token': ADMIN_TOKEN } });
  if (!r.ok) {
    const txt = await r.text();
    throw new Error(`HTTP ${r.status} ${r.statusText} — ${txt.slice(0, 200)}`);
  }
  return r.json();
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const item of arr) {
    const k = fn(item);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(item);
  }
  return m;
}

function topN(map, n = 10) {
  return [...map.entries()]
    .map(([k, v]) => ({ key: k, count: v.length, samples: v.slice(0, 3) }))
    .sort((a, b) => b.count - a.count)
    .slice(0, n);
}

/* ─────────────────────── Analyse ─────────────────────── */
function analyze(rows) {
  const errors = rows.filter((r) => r.status === 'error');
  const sent = rows.filter((r) => r.status === 'sent' || r.status === 'success');

  /* 1. Errors gegroepeerd per type */
  const errorsByType = groupBy(errors, (r) => r.type || '(geen type)');

  /* 2. Errors per error-message (eerste 120 chars) */
  const errorsByMessage = groupBy(errors, (r) => {
    const m = String(r.error || r.message || '(geen melding)').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return m.slice(0, 120);
  });

  /* 3. Errors per store */
  const errorsByStore = groupBy(errors, (r) => r.store || '(geen store)');

  /* 4. HTML-pollution in error-veld */
  const htmlPollution = errors.filter((r) => /<\w+[^>]*>/.test(String(r.error || '')));

  /* 5. Config-errors (type eindigt op _config) */
  const configErrors = rows.filter((r) => /_config$/.test(r.type || ''));

  /* 6. Run-errors (type eindigt op _run_error) */
  const runErrors = rows.filter((r) => /_run_error$/.test(r.type || ''));

  /* 7. Stores die GEEN mails hebben gehad in laatste 7 dagen */
  const last7 = daysAgo(7);
  const recentRows = rows.filter((r) => new Date(r.createdAt || r.sentAt || 0) >= last7);
  const storesWithMail = new Set(recentRows.filter((r) => r.status === 'sent' || r.status === 'success').map((r) => r.store).filter(Boolean));
  const storesWithoutMail7d = ALL_STORES
    .filter((s) => !EXCLUDED_FROM_STORE_MAIL.has(s))
    .filter((s) => !storesWithMail.has(s));

  /* 8. Per cron-type: welke stores misten mail laatste 7d? */
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
    missingPerType[t] = ALL_STORES
      .filter((s) => !EXCLUDED_FROM_STORE_MAIL.has(s))
      .filter((s) => !storesForType.has(s));
  }

  /* 9. Resend-specifieke patronen */
  const resendIssues = {
    rateLimit: errors.filter((r) => /rate.?limit|too many/i.test(String(r.error || ''))).length,
    authFail: errors.filter((r) => /unauthor|invalid.?api.?key|401/i.test(String(r.error || ''))).length,
    bounced: errors.filter((r) => /bounce|invalid.?recipient|undeliverable/i.test(String(r.error || ''))).length,
    timeout: errors.filter((r) => /timeout|aborted|econn|enotfound/i.test(String(r.error || ''))).length
  };

  /* 10. Stores zonder geconfigureerd e-mail (config-errors per store) */
  const storesNoEmail = new Set(configErrors.map((r) => r.store).filter(Boolean));

  return {
    totaal: rows.length,
    verzonden: sent.length,
    errors: errors.length,
    successRate: rows.length ? (sent.length / rows.length * 100).toFixed(1) + '%' : '–',
    topErrorTypes: topN(errorsByType, 10),
    topErrorMessages: topN(errorsByMessage, 10),
    topErrorStores: topN(errorsByStore, 15),
    htmlPollution: htmlPollution.length,
    htmlPollutionSamples: htmlPollution.slice(0, 3).map((r) => ({ type: r.type, store: r.store, errorPrefix: String(r.error || '').slice(0, 80) })),
    configErrors: configErrors.length,
    storesNoEmail: [...storesNoEmail],
    runErrors: runErrors.length,
    runErrorSamples: runErrors.slice(0, 5).map((r) => ({ type: r.type, store: r.store, error: String(r.error || '').slice(0, 200), at: r.createdAt })),
    storesWithoutAnyMail7d: storesWithoutMail7d,
    missingPerType,
    resendIssues
  };
}

/* ─────────────────────── Rapport printen ─────────────────────── */
function printReport(report, dateFrom, dateTo) {
  const line = '─'.repeat(72);
  console.log('');
  console.log(line);
  console.log(`  MAIL-LOG AUDIT  ·  ${dateFrom}  →  ${dateTo}`);
  console.log(line);
  console.log('');
  console.log(`Totaal entries:    ${report.totaal}`);
  console.log(`Verzonden (sent):  ${report.verzonden}`);
  console.log(`Errors:            ${report.errors}`);
  console.log(`Success-rate:      ${report.successRate}`);
  console.log('');

  console.log('── 1. ERRORS PER TYPE ───────────────────────────────────────────────');
  if (!report.topErrorTypes.length) console.log('   (geen errors)');
  for (const e of report.topErrorTypes) {
    console.log(`   ${String(e.count).padStart(5)}  ${e.key}`);
  }
  console.log('');

  console.log('── 2. ERRORS PER STORE ──────────────────────────────────────────────');
  if (!report.topErrorStores.length) console.log('   (geen errors)');
  for (const e of report.topErrorStores) {
    console.log(`   ${String(e.count).padStart(5)}  ${e.key}`);
  }
  console.log('');

  console.log('── 3. ERRORS PER FOUTMELDING (eerste 120 chars) ─────────────────────');
  if (!report.topErrorMessages.length) console.log('   (geen errors)');
  for (const e of report.topErrorMessages) {
    console.log(`   ${String(e.count).padStart(5)}  ${e.key}`);
  }
  console.log('');

  console.log('── 4. RESEND-PATRONEN ───────────────────────────────────────────────');
  console.log(`   Rate-limit hits:   ${report.resendIssues.rateLimit}`);
  console.log(`   Auth-fouten:       ${report.resendIssues.authFail}`);
  console.log(`   Bounces:           ${report.resendIssues.bounced}`);
  console.log(`   Timeouts:          ${report.resendIssues.timeout}`);
  console.log('');

  console.log('── 5. CONFIG- + RUN-ERRORS ──────────────────────────────────────────');
  console.log(`   Config-errors:     ${report.configErrors}   (geen mailadres geconfigureerd)`);
  if (report.storesNoEmail.length) {
    console.log(`   Stores zonder e-mail:`);
    for (const s of report.storesNoEmail) console.log(`      · ${s}`);
  }
  console.log(`   Run-errors:        ${report.runErrors}   (cron-handler faalde)`);
  for (const r of report.runErrorSamples) {
    console.log(`      · [${r.type}] ${r.store || '–'} @ ${r.at}`);
    console.log(`         ${r.error}`);
  }
  console.log('');

  console.log('── 6. HTML-POLLUTION (oude bug — zou 0 moeten zijn) ─────────────────');
  console.log(`   ${report.htmlPollution} entries met HTML in error-veld`);
  for (const s of report.htmlPollutionSamples) {
    console.log(`      · [${s.type}] ${s.store} — "${s.errorPrefix}..."`);
  }
  console.log('');

  console.log('── 7. STORES ZONDER ENKELE MAIL LAATSTE 7 DAGEN ─────────────────────');
  if (!report.storesWithoutAnyMail7d.length) {
    console.log('   Alle stores hebben minstens 1 mail ontvangen.');
  } else {
    for (const s of report.storesWithoutAnyMail7d) console.log(`   ⚠ ${s}`);
  }
  console.log('');

  console.log('── 8. STORES MET ONTBREKENDE MAIL PER CRON-TYPE (laatste 7 dagen) ──');
  for (const [type, stores] of Object.entries(report.missingPerType)) {
    if (!stores.length) {
      console.log(`   ${type}: alle stores gemaild ✓`);
    } else {
      console.log(`   ${type}: ${stores.length} stores misten mail:`);
      for (const s of stores) console.log(`      · ${s}`);
    }
  }
  console.log('');

  console.log(line);
  console.log('  EINDE RAPPORT — kopieer dit volledig terug naar Claude voor analyse');
  console.log(line);
  console.log('');
}

/* ─────────────────────── Main ─────────────────────── */
(async () => {
  const dateTo = isoDate(new Date());
  const dateFrom = isoDate(daysAgo(DAYS));

  console.log(`Mail-logs ophalen: ${dateFrom} → ${dateTo} (max ${LIMIT} rows)`);
  console.log(`URL: ${STOREGENTS_URL}/api/admin/mail-log`);
  console.log('');

  let data;
  try {
    data = await fetchLogs(dateFrom, dateTo);
  } catch (e) {
    console.error('FOUT bij ophalen mail-log:', e.message);
    process.exit(1);
  }

  const rows = Array.isArray(data.rows) ? data.rows : [];
  if (!rows.length) {
    console.log('Geen mail-log entries gevonden in deze periode.');
    process.exit(0);
  }

  const report = analyze(rows);

  if (PRINT_JSON) {
    console.log(JSON.stringify({ dateFrom, dateTo, ...report }, null, 2));
  } else {
    printReport(report, dateFrom, dateTo);
  }
})().catch((e) => {
  console.error('Onverwachte fout:', e);
  process.exit(1);
});
