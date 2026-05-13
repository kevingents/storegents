import { appendMailLog } from '../../lib/gents-mail-log-store.js';
import { baseMailHtml, rowsTable, sendMail } from '../../lib/gents-mailer.js';
import { getAdminToken, requireCronSecret } from '../../lib/gents-mail-config.js';
import { getRegionReportConfig } from '../../lib/region-report-config-store.js';
import { getDragerCache, summarizeDragers } from '../../lib/srs-dragers-store.js';
import { addCurrentOverdueDrager, addLoggedWeeklyDragers, ensureWeeklyDragerRow } from '../../lib/region-weekly-drager-memory.js';

function setHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-token, x-admin-pin, authorization');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
}

function adminOk(req) {
  const expected = getAdminToken();
  const given = String(req.headers['x-admin-token'] || req.headers['x-admin-pin'] || req.headers.authorization || req.query.adminToken || req.query.admin_token || req.query.token || '').replace(/^Bearer\s+/i, '').trim();
  return Boolean(expected && given && expected === given);
}

function isoDate(date) { return date.toISOString().slice(0, 10); }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate() + days); return d; }
function startOfPreviousWeek() { const now = new Date(); const day = now.getDay() || 7; const monday = addDays(now, 1 - day); return addDays(monday, -7); }
function endOfPreviousWeek() { return addDays(startOfPreviousWeek(), 6); }
function n(value) { return Number.isFinite(Number(value)) ? Number(value) : 0; }
function id(row = {}) { return String(row.dragerId || row.id || row.nummer || row.barcode || '').trim(); }
function age(row = {}) { const hours = n(row.ageHours); if (hours < 48) return `${hours} uur`; return `${Math.floor(hours / 24)}d ${hours % 24}u`; }

function buildWeeklyMap(rows, config) {
  const map = new Map();
  for (const region of config.regions || []) {
    for (const store of region.stores || []) {
      const summary = summarizeDragers(rows, store);
      const target = ensureWeeklyDragerRow(map, store);
      target.openCount = summary.openCount;
      target.oldestAgeHours = summary.oldestAgeHours;
      for (const row of summary.overdueRows || []) addCurrentOverdueDrager(map, store, row, id(row), row.ageHours || 0);
    }
  }
  return map;
}

function summarizeRegion(region, weeklyMap) {
  const stores = new Set(region.stores || []);
  const rows = Array.from(weeklyMap.values()).filter((row) => stores.has(row.store) && row.overdueCount > 0).sort((a, b) => b.overdueCount - a.overdueCount || a.store.localeCompare(b.store, 'nl'));
  return {
    rows,
    totals: {
      storesWithLateDragers: rows.length,
      lateDragersThisWeek: rows.reduce((sum, row) => sum + n(row.overdueCount), 0),
      currentLateDragers: rows.reduce((sum, row) => sum + n(row.currentOverdueCount), 0),
      receivedAfterLate: rows.reduce((sum, row) => sum + Math.max(0, n(row.overdueCount) - n(row.currentOverdueCount)), 0),
      openDragersNow: rows.reduce((sum, row) => sum + n(row.openCount), 0)
    }
  };
}

function reportHtml(region, summary, dateFrom, dateTo) {
  return `
    <div style="padding:16px;border:1px solid #e1e6eb;border-radius:16px;background:#f8fafc;margin-bottom:18px;">
      <strong>Periode:</strong> ${dateFrom} t/m ${dateTo}<br>
      <strong>Regio:</strong> ${region.name}<br>
      <span style="color:#3a4a5a;">Dragers blijven meetellen zodra ze deze week als te laat zijn geregistreerd, ook als ze later zijn binnengemeld.</span>
    </div>
    <h2 style="font-size:18px;color:#0a1f33;">Dragers totaal</h2>
    ${rowsTable([
      { label: 'Winkels met te late dragers', value: summary.totals.storesWithLateDragers },
      { label: 'Te laat deze week', value: summary.totals.lateDragersThisWeek },
      { label: 'Nu nog te laat', value: summary.totals.currentLateDragers },
      { label: 'Binnengemeld na te laat', value: summary.totals.receivedAfterLate },
      { label: 'Open dragers nu', value: summary.totals.openDragersNow }
    ], [{ label: 'Metric', value: (row) => row.label }, { label: 'Aantal', value: (row) => row.value }])}
    <h2 style="font-size:18px;color:#0a1f33;margin-top:24px;">Te late dragers per winkel</h2>
    ${summary.rows.length ? rowsTable(summary.rows, [
      { label: 'Winkel', value: (row) => row.store },
      { label: 'Open nu', value: (row) => row.openCount },
      { label: 'Te laat deze week', value: (row) => row.overdueCount },
      { label: 'Nu nog te laat', value: (row) => row.currentOverdueCount || 0 },
      { label: 'Binnengemeld na te laat', value: (row) => Math.max(0, n(row.overdueCount) - n(row.currentOverdueCount)) },
      { label: 'Oudste huidige', value: (row) => row.oldestAgeHours ? age(row) : '-' }
    ]) : '<p style="color:#3a4a5a;">Geen te late dragers geregistreerd in deze regio.</p>'}`;
}

export default async function handler(req, res) {
  setHeaders(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  return res.status(410).json({ success: false, message: 'Dragers functie is tijdelijk uitgeschakeld omdat SRS-koppeling nog niet stabiel is.' });
}
