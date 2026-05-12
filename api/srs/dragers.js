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

  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET is toegestaan.' });
  if (requireAdmin(req, res)) return;

  const store = clean(req.query.store);
  const refresh = String(req.query.refresh || '') === '1';
  const admin = String(req.query.admin || '') === '1';
  const dragerId = clean(req.query.dragerId || req.query.id || req.query.drager);
  const updatedFrom = clean(req.query.updatedFrom || req.query.from || (refresh ? defaultUpdatedFrom(req) : ''));
  const updatedTo = clean(req.query.updatedTo || req.query.to || (refresh ? iso(new Date()) : ''));

  try {
    let rows = await getDragerCache();
    let source = 'cache';
    let notice = '';
    let incomingCount = 0;

    if (refresh) {
      const data = await getDragerInfo({ store: dragerId ? store : '', dragerId, updatedFrom, updatedTo });
      const incoming = Array.isArray(data.rows) ? data.rows : [];
      incomingCount = incoming.length;

      if (dragerId) {
        const existing = rows.filter((row) => clean(row.dragerId || row.id) !== dragerId);
        rows = await saveDragerCache([...incoming, ...existing]);
      } else {
        rows = await saveDragerCache(mergeRows(rows, incoming));
      }

      source = 'soap';
      if (!incoming.length) notice = `SRS gaf geen dragers terug voor ${updatedFrom} t/m ${updatedTo}.`;
    }

    if (admin) {
      const stores = summarizeDragersByStore(rows);
      return res.status(200).json({
        success: true,
        source,
        notice,
        updatedFrom,
        updatedTo,
        incomingCount,
        requiresDragerIdForLiveRefresh: false,
        stores,
        totals: {
          openCount: stores.reduce((sum, row) => sum + Number(row.openCount || 0), 0),
          overdueCount: stores.reduce((sum, row) => sum + Number(row.overdueCount || 0), 0),
          storesWithOverdue: stores.filter((row) => Number(row.overdueCount || 0) > 0).length
        }
      });
    }

    const summary = summarizeDragers(rows, store);
    return res.status(200).json({ success: true, source, notice, updatedFrom, updatedTo, incomingCount, requiresDragerIdForLiveRefresh: false, ...summary });
  } catch (error) {
    const message = String(error.message || 'Dragers konden niet worden geladen.');
    return res.status(500).json({ success: false, message, updatedFrom, updatedTo });
  }
}
