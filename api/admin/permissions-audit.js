/**
 * GET /api/admin/permissions-audit?limit=100
 * Read-only audit-log van role/permission wijzigingen.
 */
import { getAuditLog } from '../../lib/permissions-audit-store.js';
import { requireSystemAdmin } from '../../lib/permission-guards.js';
import { handleCors, setCorsHeaders } from '../../lib/cors.js';

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (requireSystemAdmin(req, res)) return;
  if (req.method !== 'GET') return res.status(405).json({ success: false, message: 'Alleen GET.' });

  try {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
    const targetUserId = String(req.query.userId || '').trim();
    let rows = await getAuditLog({ limit: 500, refresh: true });
    if (targetUserId) rows = rows.filter((r) => r.targetUserId === targetUserId);
    return res.status(200).json({ success: true, count: rows.length, rows: rows.slice(0, limit) });
  } catch (error) {
    console.error('[admin/permissions-audit]', error);
    return res.status(500).json({ success: false, message: error.message || 'Onverwachte fout.' });
  }
}
