import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { fetchInternalApi } from '../../lib/gents-mail-config.js';
import { sendMail } from '../../lib/gents-mailer.js';
import { getTargetsForStores } from '../../lib/kpi-targets-store.js';
import { appendMailLog } from '../../lib/gents-mail-log-store.js';
import { computeReportRanges, buildOverviewEmailHtml, readMailConfig, resolveOverviewRecipients } from '../../lib/customer-report-mail.js';

/**
 * POST /api/admin/customer-report-send-now
 *   body: { mode:'weekly'|'monthly', confirm:true }
 *         { mode, dryRun:true }   → toont alleen wie het zou ontvangen, verstuurt niets
 *
 * Verstuurt het klanten-rapport NU eenmalig naar de ECHTE ontvangerslijst
 * (winkel-emails + extra ontvangers uit de config) — los van de maandag/1e-cron
 * én los van de 'automatische verzending'-toggle (dit is een expliciete admin-actie).
 * Echte verzending vereist confirm:true.
 *
 * Auth: admin-token.
 */

export const maxDuration = 120;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (requireAdmin(req, res)) return;

  const b = parseBody(req);
  const mode = ['weekly', 'monthly'].includes(String(b.mode || '').toLowerCase()) ? String(b.mode).toLowerCase() : 'weekly';
  const dryRun = b.dryRun === true || String(b.preview || '') === '1';

  try {
    const config = await readMailConfig();
    const recipients = await resolveOverviewRecipients(config);
    if (!recipients.length) {
      return res.status(200).json({ success: false, message: 'Geen ontvangers ingesteld (winkel-emails + extra ontvangers zijn beide leeg).' });
    }
    if (dryRun) {
      return res.status(200).json({ success: true, dryRun: true, mode, recipientCount: recipients.length, recipients });
    }
    if (b.confirm !== true) {
      return res.status(400).json({ success: false, message: 'Bevestiging vereist (confirm:true).', recipientCount: recipients.length });
    }

    const ranges = computeReportRanges(mode);
    let report;
    try {
      report = await fetchInternalApi(req, `/api/admin/customers/weekly-report?dateFrom=${ranges.range.from}&dateTo=${ranges.range.to}&t=${Date.now()}`, {
        timeoutMs: Number(process.env.CUSTOMER_MAIL_FETCH_TIMEOUT_MS || 60000)
      });
    } catch (err) {
      return res.status(200).json({ success: false, message: `Rapport ophalen mislukte: ${err.message}` });
    }
    const rows = report.rows || [];

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

    let result;
    try {
      result = await sendMail({ to: recipients, subject, html, text: subject });
    } catch (error) {
      await appendMailLog({ type: `customer_${mode}_overview_error`, store: 'ALLE', key: `manual-${mode}-${ranges.range.from}`, status: 'error', recipient: recipients.join(', '), message: error.message }).catch(() => {});
      return res.status(200).json({ success: false, message: `Versturen mislukte: ${error.message}` });
    }
    await appendMailLog({
      type: `customer_${mode}_overview`, store: 'ALLE',
      key: `manual-${mode}-${ranges.range.from}`, status: 'sent', recipient: recipients.join(', '), resendId: result.resendId || ''
    }).catch(() => {});

    return res.status(200).json({ success: true, mode, label: ranges.label, stores: rows.length, recipientCount: recipients.length, resendId: result.resendId || '' });
  } catch (error) {
    console.error('[admin/customer-report-send-now]', error);
    return res.status(200).json({ success: false, message: error.message || 'Versturen mislukte.' });
  }
}
