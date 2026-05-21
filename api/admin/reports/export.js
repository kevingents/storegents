import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { buildReport, getSupportedReportKeys } from '../../../lib/report-data-fetchers.js';
import { rowsToCsv, rowsToPdfHtml } from '../../../lib/report-formats.js';
import { put } from '@vercel/blob';
import { sendMail, baseMailHtml } from '../../../lib/gents-mailer.js';
import crypto from 'node:crypto';

/**
 * POST /api/admin/reports/export
 *
 * Body: { reportKey, format: 'csv' | 'pdf' | 'email', recipient?, params? }
 *
 * CSV   → returnt {success, downloadUrl, fileName} naar een Blob met text/csv
 * PDF   → returnt {success, downloadUrl, fileName} naar een Blob met text/html
 *         (browser opent het document → window.print() → "Opslaan als PDF")
 * Email → mailt {recipient} een link naar het rapport (PDF-html) en returnt
 *         {success, sent:true, downloadUrl}
 *
 * Alle uploads gaan naar admin/reports/<reportKey>-<ts>-<rand>.{csv|html}
 * met cacheControlMaxAge=300. De download-URL is publiek leesbaar (Blob is
 * public) maar de pad-naam is niet te raden → "unguessable URL"-pattern.
 *
 * GET → returnt {success, supportedReports} voor frontend-detectie.
 */

const ALLOWED_FORMATS = new Set(['csv', 'pdf', 'email']);
const MAX_RECIPIENTS = 5;

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

function safeFileName(reportKey, ext) {
  const cleanKey = String(reportKey || 'rapport').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const dateStr = new Date().toISOString().slice(0, 10);
  return `gents-${cleanKey}-${dateStr}.${ext}`;
}

function arrayifyRecipients(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String).map((v) => v.trim());
  return String(value).split(/[,;]/).map((v) => v.trim()).filter(Boolean);
}

function uniqueBlobPath(reportKey, ext) {
  const rand = crypto.randomBytes(8).toString('hex');
  const ts = Date.now();
  const cleanKey = String(reportKey || 'rapport').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  return `admin/reports/${cleanKey}-${ts}-${rand}.${ext}`;
}

async function uploadFile(path, body, contentType) {
  const blob = await put(path, body, {
    access: 'public',
    allowOverwrite: false,
    contentType,
    cacheControlMaxAge: 300
  });
  return blob.url;
}

function buildMailHtml(report, downloadUrl) {
  const intro = `Het rapport "${report.title}" is klaar. Klik op onderstaande link om het te bekijken — je kunt het direct opslaan als PDF via de print-knop in je browser.`;
  const bodyHtml = `
    <p style="margin:0 0 18px;font-size:15px;line-height:1.55;color:#0a1f33;">
      <a href="${downloadUrl}"
         style="display:inline-block;background:#0a1f33;color:#fff;text-decoration:none;
                padding:12px 22px;border-radius:999px;font-weight:600;letter-spacing:.02em;">
        Open rapport
      </a>
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#3a4a5a;line-height:1.55;">
      <strong>Inhoud:</strong> ${report.subtitle || '—'}
    </p>
    <p style="margin:0 0 8px;font-size:13px;color:#3a4a5a;">
      <strong>Aantal rijen:</strong> ${(report.rows || []).length}
    </p>
    <p style="margin:14px 0 0;font-size:12px;color:#6e7d8e;">
      Link is geldig zolang het bestand in onze opslag staat (≈ 7 dagen).
    </p>`;
  return baseMailHtml({
    title: report.title,
    intro,
    bodyHtml,
    footer: 'Automatisch verstuurd vanuit het GENTS Winkelportaal — Rapportages module.'
  });
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  if (req.method === 'GET') {
    return res.status(200).json({
      success: true,
      supportedReports: getSupportedReportKeys()
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen GET of POST.' });
  }

  try {
    const body = parseBody(req);
    const reportKey = String(body.reportKey || '').trim();
    const format = String(body.format || 'csv').trim().toLowerCase();
    const params = body.params || {};

    if (!reportKey) {
      return res.status(400).json({ success: false, message: 'reportKey ontbreekt.' });
    }
    if (!ALLOWED_FORMATS.has(format)) {
      return res.status(400).json({ success: false, message: `format moet csv, pdf of email zijn.` });
    }

    const report = await buildReport(reportKey, params);
    if (!report) {
      return res.status(400).json({
        success: false,
        notSupported: true,
        message: `Rapport "${reportKey}" heeft geen server-side export. Open het rapport en exporteer via de pagina zelf.`,
        supportedReports: getSupportedReportKeys()
      });
    }

    /* ──────────── CSV ──────────── */
    if (format === 'csv') {
      const csv = rowsToCsv(report);
      const path = uniqueBlobPath(reportKey, 'csv');
      const fileName = safeFileName(reportKey, 'csv');
      const url = await uploadFile(path, csv, 'text/csv; charset=utf-8');
      return res.status(200).json({
        success: true,
        format: 'csv',
        downloadUrl: url,
        fileName,
        rowCount: (report.rows || []).length
      });
    }

    /* ──────────── PDF (print-ready HTML) ──────────── */
    if (format === 'pdf') {
      const html = rowsToPdfHtml(report, { autoPrint: true });
      const path = uniqueBlobPath(reportKey, 'html');
      const fileName = safeFileName(reportKey, 'pdf');
      const url = await uploadFile(path, html, 'text/html; charset=utf-8');
      return res.status(200).json({
        success: true,
        format: 'pdf',
        downloadUrl: url,
        fileName,
        rowCount: (report.rows || []).length,
        note: 'Open de URL in een nieuw tabblad — gebruik Ctrl+P / Cmd+P om op te slaan als PDF.'
      });
    }

    /* ──────────── EMAIL met link ──────────── */
    if (format === 'email') {
      const recipients = arrayifyRecipients(body.recipient || body.recipients);
      if (!recipients.length) {
        return res.status(400).json({ success: false, message: 'Geef minstens één ontvanger op.' });
      }
      if (recipients.length > MAX_RECIPIENTS) {
        return res.status(400).json({ success: false, message: `Maximaal ${MAX_RECIPIENTS} ontvangers per e-mail.` });
      }

      /* Genereer beide formats — link in mail → PDF-html, attached CSV als bijlage-link */
      const htmlReport = rowsToPdfHtml(report, { autoPrint: true });
      const csvReport = rowsToCsv(report);
      const htmlPath = uniqueBlobPath(reportKey, 'html');
      const csvPath = uniqueBlobPath(reportKey, 'csv');
      const [htmlUrl, csvUrl] = await Promise.all([
        uploadFile(htmlPath, htmlReport, 'text/html; charset=utf-8'),
        uploadFile(csvPath, csvReport, 'text/csv; charset=utf-8')
      ]);

      const subject = `GENTS Rapport: ${report.title}`;
      const mailHtml = baseMailHtml({
        title: report.title,
        intro: `Hier is het opgevraagde GENTS-rapport. Open de online-versie of download de CSV — beide links blijven ~7 dagen geldig.`,
        bodyHtml: `
          <div style="display:flex;flex-direction:column;gap:10px;margin:0 0 18px;">
            <a href="${htmlUrl}" style="display:inline-block;background:#0a1f33;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600;text-align:center;">Open rapport (PDF-printbaar)</a>
            <a href="${csvUrl}" style="display:inline-block;background:#fff;color:#0a1f33;border:1px solid #0a1f33;text-decoration:none;padding:11px 22px;border-radius:999px;font-weight:600;text-align:center;">Download CSV</a>
          </div>
          <p style="margin:0;font-size:13px;color:#3a4a5a;"><strong>Inhoud:</strong> ${report.subtitle || '—'}</p>
          <p style="margin:6px 0 0;font-size:13px;color:#3a4a5a;"><strong>Aantal rijen:</strong> ${(report.rows || []).length}</p>`,
        footer: 'Verzonden vanuit het GENTS Winkelportaal — Rapportages.'
      });

      await sendMail({
        to: recipients,
        subject,
        html: mailHtml,
        text: `${report.title}\n\n${report.subtitle || ''}\n\nOnline rapport: ${htmlUrl}\nCSV download: ${csvUrl}`
      });

      return res.status(200).json({
        success: true,
        format: 'email',
        sent: true,
        recipients,
        downloadUrl: htmlUrl,
        csvUrl,
        rowCount: (report.rows || []).length
      });
    }

    return res.status(400).json({ success: false, message: 'Onbekend format.' });
  } catch (error) {
    console.error('[admin/reports/export]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Export mislukt.'
    });
  }
}
