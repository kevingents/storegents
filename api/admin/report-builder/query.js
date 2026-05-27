/**
 * /api/admin/report-builder/query
 *
 * POST body: {
 *   source: 'mail-log',
 *   filters: { dateRange: { from, to }, type: ['pickup'], store: ['GENTS Arnhem'] },
 *   columns: ['createdAt', 'type', 'store', 'status'],
 *   groupBy: 'store',                       // optional
 *   aggregate: { amount: 'sum', _count: 'count' },  // optional, gebruikt bij groupBy
 *   sortBy: 'createdAt',
 *   sortDir: 'desc',
 *   limit: 5000,
 *   preview: false                          // true → max 50 rijen
 * }
 *
 * Returns: {
 *   success: true,
 *   columns: [{ key, label, type }, ...],
 *   rows: [...],
 *   totalRows: 1234,
 *   truncated: false,
 *   executionMs: 142,
 *   sourceLabel: 'Mail-log'
 * }
 *
 * Auth: admin-token vereist.
 */

import { applyQuery } from '../../../lib/report-builder-sources.js';
import { corsJson, requireAdmin } from '../../../lib/request-guards.js';

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (corsJson(req, res, ['POST', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  try {
    const body = parseBody(req);
    const source = String(body.source || '').trim();
    if (!source) {
      return res.status(400).json({ success: false, message: 'source is verplicht.' });
    }

    const result = await applyQuery(source, {
      filters:   body.filters   || {},
      columns:   body.columns   || null,
      groupBy:   body.groupBy   || null,
      aggregate: body.aggregate || null,
      sortBy:    body.sortBy    || null,
      sortDir:   body.sortDir   || 'asc',
      limit:     body.limit     || null,
      preview:   Boolean(body.preview)
    });

    return res.status(200).json({ success: true, ...result });
  } catch (e) {
    console.error('[admin/report-builder/query]', e);
    return res.status(500).json({ success: false, message: e.message || 'Query-fout.' });
  }
}
