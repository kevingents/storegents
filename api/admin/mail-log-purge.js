import { handleCors, setCorsHeaders, requireAdmin } from '../../lib/cors.js';
import { purgeMailLog } from '../../lib/gents-mail-log-store.js';
import { appendAuditEntry } from '../../lib/permissions-audit-store.js';

/**
 * POST /api/admin/mail-log-purge
 *
 * Body (alle velden optioneel — minimaal één is vereist):
 *   {
 *     statuses: ['error', 'dry_run'],   // status-filter
 *     types: ['pickup_run_error', ...], // type-filter
 *     olderThanDays: 30                  // optionele leeftijd-filter
 *   }
 *
 * Verwijdert ALLE rijen in de mail-log die matchen op de filters
 * (AND-combinatie). Returnt { removed, remaining }.
 */

function parseBody(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  return req.body || {};
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (requireAdmin(req, res)) return;

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Alleen POST.' });
  }

  try {
    const body = parseBody(req);
    const statuses = Array.isArray(body.statuses) ? body.statuses.filter(Boolean) : [];
    const types = Array.isArray(body.types) ? body.types.filter(Boolean) : [];
    const olderThanDays = body.olderThanDays != null && body.olderThanDays !== ''
      ? Number(body.olderThanDays)
      : null;

    if (!statuses.length && !types.length && (olderThanDays == null || !Number.isFinite(olderThanDays))) {
      return res.status(400).json({
        success: false,
        message: 'Geef minstens één filter op (statuses, types of olderThanDays).'
      });
    }

    const actor = String(req.headers['x-actor'] || body.actor || 'admin').trim() || 'admin';
    const result = await purgeMailLog({ statuses, types, olderThanDays });

    await appendAuditEntry({
      actor,
      action: 'purge-mail-log',
      targetUserId: 'mail-log',
      after: { statuses, types, olderThanDays, removed: result.removed, remaining: result.remaining },
      request: req
    }).catch(() => {});

    return res.status(200).json({ success: true, ...result, filters: { statuses, types, olderThanDays } });
  } catch (error) {
    console.error('[admin/mail-log-purge]', error);
    return res.status(500).json({
      success: false,
      message: error.message || 'Cleanup mislukt.'
    });
  }
}
