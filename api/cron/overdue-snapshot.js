/**
 * GET /api/cron/overdue-snapshot
 *
 * Dagelijkse momentopname: scant alle open weborders en registreert per winkel
 * welke vandaag te laat zijn in de overdue-snapshot. Zo bouwt het weekrapport
 * "te laat in periode" op uit de echte dagelijkse waarnemingen — volledig en
 * onafhankelijk van wat gemaild (mail-log) is.
 *
 * Auth: cron-secret (WEBORDER_MAIL_SECRET) OF admin-token.
 */

import { requireCronSecret, getAdminToken } from '../../lib/gents-mail-config.js';
import { getSrsOpenWeborders } from '../../lib/srs-open-weborders-client.js';
import { normalizeWeborder, isOpenWeborderStatus, isClosedWeborderStatus } from '../../lib/weborder-request-store.js';
import { isOverdueWithWeekendRule } from '../../lib/gents-business-deadline.js';
import { getRegionReportConfig } from '../../lib/region-report-config-store.js';
import { recordOverdueOrders } from '../../lib/weekly-overdue-snapshot-store.js';
import { trackedCron } from '../../lib/cron-auto-track.js';

const clean = (v) => String(v == null ? '' : v).trim();
function orderKey(it = {}) {
  return clean(it.orderLineId || it.id || `${it.orderNr || ''}-${it.sku || ''}`);
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method !== 'GET' && req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen GET/POST.' });

  const expected = getAdminToken();
  const given = clean(req.headers['x-admin-token'] || req.query.adminToken || req.query.admin_token || '').replace(/^Bearer\s+/i, '');
  const isAdmin = Boolean(expected && given && expected === given);
  if (!isAdmin && !requireCronSecret(req, res, 'WEBORDER_MAIL_SECRET')) return;

  let deadlineDays = 2;
  try { deadlineDays = Number((await getRegionReportConfig()).deadlineOperationalDays || 2) || 2; } catch (_) {}

  let items = [];
  try {
    const r = await getSrsOpenWeborders({});
    items = r.items || [];
  } catch (error) {
    return res.status(200).json({ success: false, message: error.message || 'open-weborders fetch faalde' });
  }

  const seen = new Set();
  const entries = [];
  for (const raw of items) {
    const it = normalizeWeborder(raw);
    if (it.closed || it.delivered) continue;
    if (!isOpenWeborderStatus(it.status) || isClosedWeborderStatus(it.status)) continue;
    const created = it.createdAt || it.orderDate || it.created;
    const overdue = it.overdue === true || isOverdueWithWeekendRule(created, deadlineDays);
    if (!overdue) continue;
    const store = clean(it.currentStore || it.fulfilmentStore);
    const key = orderKey(it);
    if (!store || !key) continue;
    const dedup = `${store}::${key}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    entries.push({ store, key });
  }

  const result = await recordOverdueOrders(entries);
  return res.status(200).json({ success: true, scanned: items.length, overdueToday: entries.length, ...result });
}

export default trackedCron('overdue-snapshot', handler);
