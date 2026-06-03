/**
 * Klanten-rapport mail-cron — "volledig overzicht".
 *
 *   ?mode=weekly   → elke maandag: deze maand vanaf de 1e t/m vandaag
 *                    (alle winkels + totalen, gesorteerd op % met e-mail)
 *   ?mode=monthly  → 1e van de maand: vorige maand + de nieuwe targets voor
 *                    de komende maand
 *
 *   ?testTo=adres  → stuur ALLEEN naar dit adres (test); negeert de echte lijst
 *   ?dryRun=1      → niets versturen, alleen rapporteren wat zou gebeuren
 *
 * Eén geconsolideerde mail naar alle winkel-emails + de ingestelde extra
 * ontvangers (Instellingen → Klantenrapport e-mail). Automatische verzending
 * gaat pas uit zodra config.enabled === true.
 *
 * Auth: WEBORDER_MAIL_SECRET cron-secret OF admin-token.
 */

import { appendMailLog } from '../../lib/gents-mail-log-store.js';
import { sendMail } from '../../lib/gents-mailer.js';
import { fetchInternalApi, requireCronSecret } from '../../lib/gents-mail-config.js';
import { getTargetsForStores } from '../../lib/kpi-targets-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';
import { computeReportRanges, buildOverviewEmailHtml, resolveOverviewRecipients, readMailConfig } from '../../lib/customer-report-mail.js';

export const maxDuration = 120;

function setNoStore(res) { res.setHeader('Cache-Control', 'no-store, max-age=0'); }

async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }

  /* Auth: cron-secret OF admin-token. */
  const adminToken = String(process.env.ADMIN_TOKEN || (globalThis.crypto?.randomUUID?.() || String(Math.random()))).trim();
  const givenAdmin = String(req.headers['x-admin-token'] || req.query.adminToken || '').replace(/^Bearer\s+/i, '').trim();
  const isAdmin = Boolean(adminToken && givenAdmin && adminToken === givenAdmin);
  if (!isAdmin && !requireCronSecret(req, res, 'WEBORDER_MAIL_SECRET')) return;

  const mode = String(req.query.mode || 'weekly').toLowerCase();
  if (!['weekly', 'monthly'].includes(mode)) {
    return res.status(400).json({ success: false, message: 'mode moet "weekly" of "monthly" zijn.' });
  }
  const dryRun = String(req.query.dryRun || req.query.preview || '') === '1';
  const testTo = String(req.query.testTo || '').trim().toLowerCase();

  const config = await readMailConfig();
  const ranges = computeReportRanges(mode);

  let report;
  try {
    report = await fetchInternalApi(req, `/api/admin/customers/weekly-report?dateFrom=${ranges.range.from}&dateTo=${ranges.range.to}&t=${Date.now()}`, {
      timeoutMs: Number(process.env.CUSTOMER_MAIL_FETCH_TIMEOUT_MS || 60000)
    });
  } catch (err) {
    return res.status(502).json({ success: false, message: `Weekly-report fetch faalde: ${err.message}` });
  }
  const rows = report.rows || [];

  /* Maandelijks: de nieuwe targets voor de komende maand erbij. */
  let nextTargets = null;
  if (mode === 'monthly' && ranges.targetsMonth) {
    try {
      const byStore = await getTargetsForStores(ranges.targetsMonth.year, ranges.targetsMonth.month, rows.map((r) => r.store));
      nextTargets = { month: ranges.targetsMonth, byStore };
    } catch { /* targets optioneel */ }
  }

  const html = buildOverviewEmailHtml({
    mode, label: ranges.label, range: ranges.range, rows,
    asOfDay: ranges.asOfDay, isFinal: ranges.isFinal, nextTargets,
    includePodium: config.includePodium
  });
  const subject = mode === 'monthly' ? `Klanten — maandoverzicht ${ranges.label}` : `Klanten — overzicht ${ranges.label}`;

  /* Ontvangers bepalen. */
  const testMode = Boolean(testTo);
  let recipients;
  if (testMode) recipients = [testTo];
  else if (config.enabled) recipients = await resolveOverviewRecipients(config);
  else recipients = [];

  /* Niets versturen bij dryRun, uitgeschakelde auto-verzending of geen ontvangers. */
  if (dryRun || (!testMode && !config.enabled)) {
    return res.status(200).json({
      success: true, mode, label: ranges.label, dryRun: dryRun || !config.enabled,
      enabled: config.enabled, stores: rows.length, recipientCount: recipients.length, wouldSendTo: recipients,
      note: (!testMode && !config.enabled) ? 'Automatische verzending staat uit (Instellingen → Klantenrapport e-mail).' : undefined
    });
  }
  if (!recipients.length) {
    return res.status(200).json({ success: false, mode, label: ranges.label, message: 'Geen ontvangers ingesteld.' });
  }

  let result;
  try {
    result = await sendMail({ to: recipients, subject: testMode ? `[TEST] ${subject}` : subject, html, text: subject });
  } catch (error) {
    await appendMailLog({ type: `customer_${mode}_overview_error`, store: 'ALLE', key: `${mode}-${ranges.range.from}`, status: 'error', recipient: recipients.join(', '), message: error.message }).catch(() => {});
    return res.status(200).json({ success: false, mode, label: ranges.label, message: `Versturen mislukte: ${error.message}` });
  }
  await appendMailLog({
    type: `customer_${mode}_overview${testMode ? '_test' : ''}`, store: 'ALLE',
    key: `${mode}-${ranges.range.from}`, status: 'sent', recipient: recipients.join(', '), resendId: result.resendId || ''
  }).catch(() => {});

  return res.status(200).json({
    success: true, mode, label: ranges.label, testMode,
    stores: rows.length, recipientCount: recipients.length, resendId: result.resendId || ''
  });
}

export default trackedCron('customer-mail-run', handler);
