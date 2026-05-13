import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { getDragerInfo } from '../../lib/srs-dragers-soap.js';
import { getDragerCache, saveDragerCache, summarizeDragers, summarizeDragersByStore } from '../../lib/srs-dragers-store.js';

function clean(value) {
  return String(value ?? '').trim();
}

function iso(date) {
  return date.toISOString();
}

function minutesAgo(minutes) {
  const d = new Date();
  const m = Math.max(1, Number(minutes || 15));
  d.setMinutes(d.getMinutes() - m);
  return d;
}

function hoursAgo(hours) {
  const d = new Date();
  const h = Math.max(1, Number(hours || 2));
  d.setHours(d.getHours() - h);
  return d;
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - Math.max(1, Number(days || 1)));
  return d;
}

function defaultUpdatedFrom(req) {
  if (req.query.minutes !== undefined) return iso(minutesAgo(req.query.minutes));
  if (req.query.hours !== undefined) return iso(hoursAgo(req.query.hours));
  if (req.query.days !== undefined) return iso(daysAgo(req.query.days));
  if (process.env.SRS_DRAGER_SYNC_MINUTES) return iso(minutesAgo(process.env.SRS_DRAGER_SYNC_MINUTES));
  if (process.env.SRS_DRAGER_SYNC_HOURS) return iso(hoursAgo(process.env.SRS_DRAGER_SYNC_HOURS));
  return iso(minutesAgo(15));
}

function key(row = {}) {
  return clean(row.dragerId || row.id || row.nummer || row.dragerNummer || row.barcode || row.code || `${row.store || ''}-${row.createdAt || ''}-${row.updatedAt || ''}`);
}

function mergeRows(existing = [], incoming = []) {
  const map = new Map();
  [...existing, ...incoming].forEach((row) => {
    const id = key(row);
    if (id) map.set(id, row);
  });
  return Array.from(map.values());
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  return res.status(410).json({ success: false, message: 'Dragers functie is tijdelijk uitgeschakeld omdat SRS-koppeling nog niet stabiel is.' });
}
