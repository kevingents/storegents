import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { fetchInternalApi } from '../../lib/gents-mail-config.js';
import { sendMail } from '../../lib/gents-mailer.js';
import { getTargetsForStores } from '../../lib/kpi-targets-store.js';
import { computeReportRanges, buildOverviewEmailHtml, readMailConfig } from '../../lib/customer-report-mail.js';

/**
 * POST /api/admin/customer-report-test-mail
 *   body: { to:'iemand@gents.nl', mode:'weekly'|'monthly' }
 *
 * Stuurt de klanten-rapport mail (volledig overzicht) als TEST naar één adres,
 * zodat je kunt zien hoe het eruit ziet vóór de automatische verzending aan gaat.
 * Stuurt NOOIT naar de echte ontvangerslijst.
 */

export const maxDuration = 60;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  return req.body;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (requireAdmin(req, res)) return;

  const b = parseBody(req);
  const to = String(b.to || '').trim().toLowerCase();
  const mode = ['weekly', 'monthly'].includes(String(b.mode || '').toLowerCase()) ? String(b.mode).toLowerCase() : 'weekly';
  if (!to || !EMAIL_RE.test(to)) return res.status(400).json({ success: false, message: 'Geldig e-mailadres vereist.' });

  try {
    const config = await readMailConfig();
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
    const subject = `[TEST] ${mode === 'monthly' ? `Klanten — maandoverzicht ${ranges.label}` : `Klanten — overzicht ${ranges.label}`}`;

    const result = await sendMail({ to: [to], subject, html, text: subject });
    return res.status(200).json({ success: true, to, mode, label: ranges.label, stores: rows.length, resendId: result.resendId || '' });
  } catch (error) {
    console.error('[admin/customer-report-test-mail]', error);
    return res.status(200).json({ success: false, message: error.message || 'Testmail versturen mislukte.' });
  }
}
