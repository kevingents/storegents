/**
 * Report-format helpers.
 *
 * Converts {columns, rows, title, subtitle} → CSV-string of HTML-string
 * voor PDF (browser-side window.print). De PDF wordt niet server-side
 * gerenderd — we sturen styled HTML met @media print rules + auto-print,
 * de gebruiker krijgt een nette print-preview en kan "Opslaan als PDF"
 * kiezen.
 *
 * Dit voorkomt Puppeteer/chromium binaries op Vercel (te zwaar voor
 * serverless) en geeft alle rapportages een uniforme layout.
 */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function csvCell(value) {
  const str = value == null ? '' : String(value);
  /* Excel-compat: quote elke cell, escape dubbele aanhalingstekens */
  return `"${str.replace(/"/g, '""').replace(/\r?\n/g, ' ')}"`;
}

/**
 * Bouw een CSV-string.
 *
 * @param {Object} report  { columns: [{key,label}], rows: [{...}], title }
 * @returns {string}
 */
export function rowsToCsv(report) {
  const cols = report.columns || [];
  const rows = report.rows || [];

  /* Excel BOM → euro / é / etc. tonen correct in Excel-nl */
  const bom = '﻿';
  const header = cols.map((c) => csvCell(c.label || c.key)).join(',');
  const dataLines = rows.map((row) =>
    cols.map((c) => csvCell(row[c.key])).join(',')
  );

  return bom + [header, ...dataLines].join('\r\n');
}

/**
 * Bouw een print-ready HTML-document. Bevat auto-print script
 * en GENTS-branding. De gebruiker krijgt het document in de browser
 * en kan via Cmd+P / Ctrl+P → "Opslaan als PDF" kiezen.
 *
 * @param {Object} report  { columns, rows, title, subtitle, generatedAt, filters }
 * @param {Object} options { autoPrint: boolean }
 * @returns {string}
 */
export function rowsToPdfHtml(report, options = {}) {
  const cols = report.columns || [];
  const rows = report.rows || [];
  const title = report.title || 'Rapport';
  const subtitle = report.subtitle || '';
  const generatedAt = report.generatedAt || new Date().toISOString();
  const filters = report.filters || {};
  const autoPrint = options.autoPrint !== false;

  const filterChips = Object.entries(filters)
    .filter(([, v]) => v !== '' && v != null && v !== undefined)
    .map(([k, v]) => `<span class="chip"><span class="chip-key">${escapeHtml(k)}</span><span class="chip-val">${escapeHtml(v)}</span></span>`)
    .join('');

  const head = `<thead><tr>${cols.map((c) => `<th>${escapeHtml(c.label || c.key)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${rows
    .map((row) => `<tr>${cols.map((c) => `<td>${escapeHtml(row[c.key])}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;

  const totals = report.totals;
  const totalsBlock = totals
    ? `<div class="totals">${Object.entries(totals)
        .map(([k, v]) => `<div class="total-item"><div class="total-key">${escapeHtml(k)}</div><div class="total-val">${escapeHtml(v)}</div></div>`)
        .join('')}</div>`
    : '';

  return `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} — GENTS Rapport</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #0a1f33; margin: 0; background: #f5f5f2; }
  .page { background: #fff; max-width: 1180px; margin: 24px auto; padding: 36px 48px; border-radius: 18px; box-shadow: 0 4px 24px rgba(0,0,0,.06); }
  .brand { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: #3a4a5a; font-weight: 700; margin-bottom: 6px; }
  h1 { font-size: 28px; font-weight: 400; letter-spacing: -.02em; margin: 0 0 6px; color: #0a1f33; }
  .subtitle { color: #3a4a5a; font-size: 14px; margin: 0 0 18px; }
  .meta { display: flex; flex-wrap: wrap; gap: 14px; align-items: center; font-size: 12px; color: #3a4a5a; margin-bottom: 20px; }
  .meta .label { font-weight: 600; color: #0a1f33; }
  .filters { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 22px; }
  .chip { display: inline-flex; align-items: center; gap: 5px; background: #f0f3f6; border: 1px solid #e1e6eb; border-radius: 999px; padding: 3px 10px; font-size: 11px; color: #3a4a5a; }
  .chip-key { font-weight: 600; }
  .totals { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 8px; margin-bottom: 22px; }
  .total-item { background: #f0f3f6; border: 1px solid #e1e6eb; border-radius: 12px; padding: 10px 14px; }
  .total-key { font-size: 11px; color: #3a4a5a; text-transform: uppercase; letter-spacing: .08em; font-weight: 600; }
  .total-val { font-size: 18px; font-weight: 600; color: #0a1f33; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  thead { background: #0a1f33; }
  thead th { color: #fff; text-align: left; padding: 10px 12px; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; }
  tbody td { padding: 8px 12px; border-bottom: 1px solid #e1e6eb; color: #0a1f33; vertical-align: top; }
  tbody tr:nth-child(even) { background: #fafbfc; }
  tbody tr:hover { background: #f0f3f6; }
  .empty { padding: 40px; text-align: center; color: #6e7d8e; font-style: italic; }
  .footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid #e1e6eb; font-size: 11px; color: #6e7d8e; }
  .actions { display: flex; gap: 10px; margin-bottom: 18px; }
  .btn { background: #0a1f33; color: #fff; border: none; border-radius: 999px; padding: 9px 18px; font-size: 13px; font-weight: 600; cursor: pointer; }
  .btn.is-secondary { background: #fff; color: #0a1f33; border: 1px solid #0a1f33; }
  @media print {
    body { background: #fff; }
    .page { box-shadow: none; margin: 0; max-width: none; padding: 14mm 12mm; border-radius: 0; }
    .actions { display: none !important; }
    thead { background: #0a1f33 !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    thead th { color: #fff !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    tbody tr:nth-child(even) { background: #fafbfc !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    .chip, .total-item { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    @page { margin: 12mm; size: A4; }
  }
</style>
</head>
<body>
<div class="page">
  <div class="actions">
    <button class="btn" onclick="window.print()">Opslaan als PDF / Printen</button>
    <button class="btn is-secondary" onclick="window.close()">Sluiten</button>
  </div>
  <div class="brand">GENTS Winkelportaal — Rapport</div>
  <h1>${escapeHtml(title)}</h1>
  ${subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : ''}
  <div class="meta">
    <span><span class="label">Gegenereerd:</span> ${escapeHtml(new Date(generatedAt).toLocaleString('nl-NL'))}</span>
    <span><span class="label">Aantal rijen:</span> ${rows.length}</span>
  </div>
  ${filterChips ? `<div class="filters">${filterChips}</div>` : ''}
  ${totalsBlock}
  ${rows.length
    ? `<table>${head}${body}</table>`
    : '<div class="empty">Geen data voor de gekozen filters.</div>'}
  <div class="footer">GENTS Herenmode · Gegenereerd via Winkelportaal · ${escapeHtml(generatedAt)}</div>
</div>
${autoPrint ? '<script>setTimeout(function(){window.print();}, 800);</script>' : ''}
</body>
</html>`;
}

/**
 * Helper: format euros voor in een rapport-cel.
 */
export function fmtEur(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '€ 0,00';
  return new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR' }).format(n);
}

/**
 * Helper: format datum.
 */
export function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('nl-NL', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

export function fmtDateTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('nl-NL');
}
