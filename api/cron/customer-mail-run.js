/**
 * Klanten-rapport mail-cron.
 *
 *   ?mode=weekly    → maandagochtend (per filiaal + regiomanager + HQ)
 *                     Inhoud: vorige week + month-to-date
 *
 *   ?mode=monthly   → 1e van de maand (per filiaal + regiomanager + HQ)
 *                     Inhoud: vorige maand per week + maand-totaal
 *
 *   ?store=NAAM     → optioneel: alleen 1 winkel testen
 *   ?dryRun=1       → mail NIET versturen, log alleen wat zou gebeuren
 *
 * Auth: WEBORDER_MAIL_SECRET cron-secret OF admin-token (admin mag handmatig
 * dryRun draaien).
 */

import { appendMailLog } from '../../lib/gents-mail-log-store.js';
import { baseMailHtml, sendMail } from '../../lib/gents-mailer.js';
import { getAdminToken, getApiBaseUrl, getStoreNames, getStoreMailAsync, isExcludedStore, requireCronSecret } from '../../lib/gents-mail-config.js';
import { getGroupMailRecipients } from '../../lib/mail-recipient-resolver.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

function setNoStore(res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function isoDate(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function startOfWeek(d = new Date()) { const day = d.getUTCDay() || 7; return addDays(d, 1 - day); }

function computeRanges(mode, now = new Date()) {
  if (mode === 'monthly') {
    const firstOfThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastOfPrev = addDays(firstOfThis, -1);
    const firstOfPrev = new Date(Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1));
    return {
      label: `${firstOfPrev.toLocaleDateString('nl-NL', { month: 'long', year: 'numeric' })}`,
      week: null,
      month: { from: isoDate(firstOfPrev), to: isoDate(lastOfPrev) }
    };
  }
  /* weekly: vorige week + month-to-date (huidige maand t/m gisteren) */
  const startThisWeek = startOfWeek(now);
  const startLastWeek = addDays(startThisWeek, -7);
  const endLastWeek = addDays(startThisWeek, -1);
  const firstOfThisMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const yesterday = addDays(now, -1);
  return {
    label: `week ${endLastWeek.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })}`,
    week: { from: isoDate(startLastWeek), to: isoDate(endLastWeek) },
    month: { from: isoDate(firstOfThisMonth), to: isoDate(yesterday) }
  };
}

async function fetchWeeklyReport(req, range, store) {
  const baseUrl = getApiBaseUrl(req);
  if (!baseUrl) throw new Error('GENTS_API_BASE_URL ontbreekt');
  const p = new URLSearchParams({ dateFrom: range.from, dateTo: range.to, t: String(Date.now()) });
  if (store) p.set('store', store);
  const url = `${baseUrl}/api/admin/customers/weekly-report?${p.toString()}`;
  const r = await fetch(url, {
    headers: { Accept: 'application/json', 'x-admin-token': getAdminToken() },
    signal: AbortSignal.timeout(Number(process.env.CUSTOMER_MAIL_FETCH_TIMEOUT_MS || 60000))
  });
  const text = await r.text();
  let d;
  try { d = text ? JSON.parse(text) : {}; } catch { d = { message: text }; }
  if (!r.ok || d.success === false) throw new Error(d.message || `weekly-report fout ${r.status}`);
  return d;
}

function pctCell(pct, target, actual) {
  if (pct == null) return `<span style="color:#94a3b8">—</span>`;
  let color = '#dc2626'; /* danger */
  if (pct >= 100) color = '#16a34a'; /* success */
  else if (pct >= 80) color = '#059669';
  else if (pct >= 50) color = '#d97706';
  return `<strong style="color:${color}">${pct}%</strong> <small style="color:#64748b">(${actual}/${target})</small>`;
}

function buildStoreMailHtml({ store, mode, label, weekRow, monthRow, weekRange, monthRange }) {
  const w = weekRow || {};
  const m = monthRow || {};
  const weekSection = weekRow ? `
    <h3 style="margin:18px 0 8px;font-size:14px">Vorige week — ${label}</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:6px">
      <tr><td>Nieuwe klanten:</td><td style="text-align:right"><strong>${w.newCount || w.total || 0}</strong> ${pctCell(w.pctInschrijvingenVsTarget, w.targetInschrijvingen, w.newCount || w.total || 0)}</td></tr>
      <tr><td>Met bon:</td><td style="text-align:right"><strong>${w.withBon || w.withReceipt || 0}</strong> ${pctCell(w.pctMetBonVsTarget, w.targetMetBon, w.withBon || w.withReceipt || 0)}</td></tr>
      <tr><td>Met email:</td><td style="text-align:right"><strong>${w.withEmail || 0}</strong> ${pctCell(w.pctMetEmailVsTarget, w.targetMetEmail, w.withEmail || 0)}</td></tr>
      <tr><td>Totaal bonnen verkocht:</td><td style="text-align:right"><strong>${w.totalReceiptsInStore || 0}</strong> ${pctCell(w.pctInschrijvingenVsBons, w.totalReceiptsInStore, w.newCount || w.total || 0)}</td></tr>
    </table>
    <small style="color:#64748b">Periode: ${weekRange?.from || '—'} t/m ${weekRange?.to || '—'}</small>
  ` : '';

  const monthSection = monthRow ? `
    <h3 style="margin:18px 0 8px;font-size:14px">Maand tot nu toe</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:6px">
      <tr><td>Nieuwe klanten:</td><td style="text-align:right"><strong>${m.newCount || m.total || 0}</strong> ${pctCell(m.pctInschrijvingenVsTarget, m.targetInschrijvingen, m.newCount || m.total || 0)}</td></tr>
      <tr><td>Met bon:</td><td style="text-align:right"><strong>${m.withBon || m.withReceipt || 0}</strong> ${pctCell(m.pctMetBonVsTarget, m.targetMetBon, m.withBon || m.withReceipt || 0)}</td></tr>
      <tr><td>Met email:</td><td style="text-align:right"><strong>${m.withEmail || 0}</strong> ${pctCell(m.pctMetEmailVsTarget, m.targetMetEmail, m.withEmail || 0)}</td></tr>
      <tr><td>Totaal bonnen verkocht:</td><td style="text-align:right"><strong>${m.totalReceiptsInStore || 0}</strong> ${pctCell(m.pctInschrijvingenVsBons, m.totalReceiptsInStore, m.newCount || m.total || 0)}</td></tr>
    </table>
    <small style="color:#64748b">Periode: ${monthRange?.from || '—'} t/m ${monthRange?.to || '—'}</small>
  ` : '';

  return baseMailHtml({
    title: mode === 'monthly'
      ? `Klanten-resultaat ${label} — ${store}`
      : `Klanten-resultaat ${label} — ${store}`,
    intro: mode === 'monthly'
      ? `Hieronder de klanteninschrijvingen voor ${store} over de afgelopen maand. Vergeleken met de gestelde target.`
      : `Wekelijks klanten-rapport voor ${store}. Vorige week + de huidige maand-tot-nu. Focus op de % vs target.`,
    bodyHtml: `${weekSection}${monthSection}
      <p style="font-size:12px;color:#64748b;margin-top:18px">
        Targets per maand worden ingesteld in het admin-portal onder <strong>Rapportages → Klanten-targets</strong>.
      </p>`
  });
}

function buildHQMailHtml({ mode, label, totals, rows, range }) {
  const r = totals || {};
  const top10 = (rows || []).slice(0, 10);
  const tableRows = top10.map((row) => `
    <tr>
      <td>${row.store}</td>
      <td style="text-align:right">${row.newCount || row.total || 0}</td>
      <td style="text-align:right">${pctCell(row.pctInschrijvingenVsTarget, row.targetInschrijvingen, row.newCount || row.total || 0)}</td>
      <td style="text-align:right">${row.totalReceiptsInStore || 0}</td>
      <td style="text-align:right">${pctCell(row.pctInschrijvingenVsBons, row.totalReceiptsInStore, row.newCount || row.total || 0)}</td>
    </tr>`).join('');

  return baseMailHtml({
    title: `HQ klanten-rapport — ${label}`,
    intro: `${mode === 'monthly' ? 'Maand-overzicht' : 'Week-overzicht'} van alle winkels. Periode: ${range?.from} t/m ${range?.to}.`,
    bodyHtml: `
      <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:14px">
        <tr><td><strong>Totaal nieuwe klanten:</strong></td><td style="text-align:right"><strong>${r.totalNew || r.total || 0}</strong> ${pctCell(r.pctInschrijvingenVsTarget, r.targetInschrijvingen, r.totalNew || r.total || 0)}</td></tr>
        <tr><td>Met bon:</td><td style="text-align:right">${r.withBon || 0} ${pctCell(r.pctMetBonVsTarget, r.targetMetBon, r.withBon || 0)}</td></tr>
        <tr><td>Met email:</td><td style="text-align:right">${r.withEmail || 0} ${pctCell(r.pctMetEmailVsTarget, r.targetMetEmail, r.withEmail || 0)}</td></tr>
        <tr><td>Totaal bonnen verkocht:</td><td style="text-align:right">${r.totalReceipts || 0} ${pctCell(r.pctInschrijvingenVsBons, r.totalReceipts, r.totalNew || r.total || 0)}</td></tr>
      </table>
      <h3 style="margin:18px 0 8px;font-size:14px">Top 10 winkels op nieuwe klanten</h3>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead><tr style="background:#f1f5f9"><th style="text-align:left;padding:6px">Winkel</th><th style="text-align:right;padding:6px">Nieuw</th><th style="text-align:right;padding:6px">% vs target</th><th style="text-align:right;padding:6px">Bonnen</th><th style="text-align:right;padding:6px">% inschr/bon</th></tr></thead>
        <tbody>${tableRows || '<tr><td colspan="5" style="color:#94a3b8;padding:6px">Geen data</td></tr>'}</tbody>
      </table>`
  });
}

async function sendStoreMail({ store, recipient, mode, html, dryRun, label }) {
  const mailType = mode === 'monthly' ? 'customer-monthly-store' : 'customer-weekly-store';
  if (dryRun) return { sent: false, count: 1, dryRun: true };

  const rcptGroup = await getGroupMailRecipients({ type: mailType, store });
  const finalTo = new Set();
  const finalCc = new Set();
  if (!rcptGroup.hasReplaceRule) {
    if (recipient.email) finalTo.add(String(recipient.email).toLowerCase());
    for (const c of (recipient.cc || [])) finalCc.add(String(c).toLowerCase());
  }
  for (const e of rcptGroup.emails) finalTo.add(e);
  if (!finalTo.size) return { sent: false, skipped: 'no-recipients' };

  const result = await sendMail({
    to: [...finalTo],
    cc: [...finalCc].filter((c) => !finalTo.has(c)),
    subject: mode === 'monthly'
      ? `Klanten-resultaat ${label} — ${store}`
      : `Klanten-resultaat ${label} — ${store}`,
    html,
    text: `Klanten-rapport voor ${store} — periode ${label}`
  });
  return { sent: true, count: 1, resendId: result.resendId || '' };
}

async function sendRegionManagerMail({ store, recipient, html, dryRun, label, mode }) {
  const managerRecipients = recipient.regionManagerEmail || [];
  if (!managerRecipients.length) return { sent: false, skipped: 'no-region-manager' };
  if (dryRun) return { sent: false, count: 1, dryRun: true };
  const mailType = mode === 'monthly' ? 'customer-monthly-region-manager' : 'customer-weekly-region-manager';
  const rcptGroup = await getGroupMailRecipients({ type: mailType, store });
  const finalTo = new Set();
  if (!rcptGroup.hasReplaceRule) {
    for (const m of managerRecipients) if (m) finalTo.add(String(m).toLowerCase());
  }
  for (const e of rcptGroup.emails) finalTo.add(e);
  if (!finalTo.size) return { sent: false, skipped: 'no-recipients' };
  const result = await sendMail({
    to: [...finalTo],
    subject: `Klanten ${label} — ${store}`,
    html,
    text: `Klanten-rapport regio — ${store} ${label}`
  });
  return { sent: true, count: 1, resendId: result.resendId || '' };
}

async function sendHQMail({ html, label, mode, dryRun }) {
  const hqRecipients = String(process.env.CUSTOMER_REPORT_HQ_RECIPIENT || process.env.HQ_REPORT_RECIPIENT || '')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const mailType = mode === 'monthly' ? 'customer-monthly-hq' : 'customer-weekly-hq';
  const rcptGroup = await getGroupMailRecipients({ type: mailType, store: 'HQ' });
  const finalTo = new Set();
  if (!rcptGroup.hasReplaceRule) for (const r of hqRecipients) finalTo.add(r);
  for (const e of rcptGroup.emails) finalTo.add(e);
  if (!finalTo.size) return { sent: false, skipped: 'no-hq-recipient' };
  if (dryRun) return { sent: false, count: 1, dryRun: true };
  const result = await sendMail({
    to: [...finalTo],
    subject: `HQ klanten-rapport — ${label}`,
    html,
    text: `HQ klanten-rapport ${label}`
  });
  return { sent: true, count: 1, resendId: result.resendId || '' };
}

async function handler(req, res) {
  setNoStore(res);
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });
  }

  /* Auth: cron-secret OF admin-token. */
  const adminToken = String(process.env.ADMIN_TOKEN || '12345').trim();
  const givenAdmin = String(req.headers['x-admin-token'] || req.query.adminToken || '').replace(/^Bearer\s+/i, '').trim();
  const isAdmin = Boolean(adminToken && givenAdmin && adminToken === givenAdmin);
  if (!isAdmin && !requireCronSecret(req, res, 'WEBORDER_MAIL_SECRET')) return;

  const mode = String(req.query.mode || 'weekly').toLowerCase();
  if (!['weekly', 'monthly'].includes(mode)) {
    return res.status(400).json({ success: false, message: 'mode moet "weekly" of "monthly" zijn.' });
  }

  const dryRun = String(req.query.dryRun || req.query.preview || '') === '1';
  const onlyStore = String(req.query.store || '').trim();
  const ranges = computeRanges(mode);

  const stores = onlyStore ? [onlyStore] : getStoreNames().filter((s) => !isExcludedStore(s));
  const results = [];

  /* Fetch global report ééns (alle stores) zodat we totals + per-store rows hebben.
     Het endpoint cached intern voor 10 min, dus de tweede call (zelfde periode)
     hergebruikt dat. */
  const primaryRange = mode === 'monthly' ? ranges.month : ranges.week;
  let allDataPrimary;
  let allDataMonthMTD;
  try {
    allDataPrimary = await fetchWeeklyReport(req, primaryRange, '');
    if (mode === 'weekly') {
      allDataMonthMTD = await fetchWeeklyReport(req, ranges.month, '');
    }
  } catch (err) {
    return res.status(502).json({ success: false, message: `Weekly-report fetch faalde: ${err.message}` });
  }
  const rowsPrimary = allDataPrimary.rows || [];
  const rowsMonthMTD = allDataMonthMTD?.rows || [];

  /* Per filiaal: bouw + verstuur 2 mails (store + regiomanager) */
  for (const store of stores) {
    try {
      const recipient = await getStoreMailAsync(store);
      const weekRow = rowsPrimary.find((r) => r.store === store);
      const monthRow = mode === 'weekly' ? rowsMonthMTD.find((r) => r.store === store) : null;
      if (!weekRow && !monthRow) {
        results.push({ store, skipped: 'no-data-for-store' });
        continue;
      }
      const html = buildStoreMailHtml({
        store, mode, label: ranges.label,
        weekRow: mode === 'monthly' ? null : weekRow,
        monthRow: mode === 'monthly' ? weekRow : monthRow,
        weekRange: ranges.week,
        monthRange: ranges.month
      });
      const storeMail = await sendStoreMail({ store, recipient, mode, html, dryRun, label: ranges.label });
      const mgrMail = await sendRegionManagerMail({ store, recipient, html, dryRun, label: ranges.label, mode });

      if (!dryRun && storeMail.sent) {
        await appendMailLog({ type: `customer_${mode}_store`, store, key: `${mode}-${primaryRange.from}`, status: 'sent', recipient: recipient.email || '', resendId: storeMail.resendId || '' });
      }
      if (!dryRun && mgrMail.sent) {
        await appendMailLog({ type: `customer_${mode}_region_manager`, store, key: `${mode}-${primaryRange.from}`, status: 'sent', recipient: (recipient.regionManagerEmail || []).join(', '), resendId: mgrMail.resendId || '' });
      }

      results.push({ store, storeMail, regionManagerMail: mgrMail });
    } catch (error) {
      results.push({ store, error: error.message });
      await appendMailLog({ type: `customer_${mode}_run_error`, store, key: 'run', status: 'error', message: error.message }).catch(() => {});
    }
  }

  /* HQ-mail: globale samenvatting */
  const hqHtml = buildHQMailHtml({
    mode,
    label: ranges.label,
    totals: allDataPrimary.totals,
    rows: rowsPrimary,
    range: primaryRange
  });
  const hqMail = await sendHQMail({ html: hqHtml, label: ranges.label, mode, dryRun });
  if (!dryRun && hqMail.sent) {
    await appendMailLog({ type: `customer_${mode}_hq`, store: 'HQ', key: `${mode}-${primaryRange.from}`, status: 'sent', resendId: hqMail.resendId || '' });
  }

  return res.status(200).json({
    success: true,
    mode,
    label: ranges.label,
    dryRun,
    stores: stores.length,
    hqMail,
    results
  });
}

export default trackedCron('customer-mail-run', handler);
