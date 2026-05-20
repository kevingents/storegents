import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getSrsReturnLogs, saveSrsReturnLogs } from '../../../lib/srs-return-log-store.js';

/**
 * POST /api/admin/return-logs/delete-orphans
 *
 * Verwijdert alle orphan retour-records uit de Blob: records zonder orderNr,
 * zonder shopifyOrderId, EN zonder succesvolle refund (shopifyRefundId leeg).
 *
 * Deze records zijn half-afgemaakte flows die niet bijgehouden hoeven worden.
 *
 * Body:
 *   { dryRun: true }                → return aantal zonder te verwijderen
 *   { logIds: ['1747...', ...] }    → verwijder alleen specifieke IDs (override
 *                                     orphan-filter)
 *
 * Response:
 *   { success, dryRun, total, orphanCount, deleted, kept }
 */

function clean(v) { return String(v || '').trim(); }

function isOrphan(log) {
  const hasOrder = clean(log.orderNr) || clean(log.shopifyOrderId);
  const hasRefund = clean(log.shopifyRefundId) || Number(log.refundAmount || 0) > 0;
  /* Echte orphan = geen order EN geen refund (volledig verlaten flow).
     Een record met refund maar zonder ordernr is iets aparts (corrupte data
     die we niet zomaar verwijderen). */
  return !hasOrder && !hasRefund;
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (requireAdmin(req, res)) return;

  const body = req.body || {};
  const dryRun = Boolean(body.dryRun);
  const explicitIds = Array.isArray(body.logIds) ? body.logIds.map(clean).filter(Boolean) : null;

  try {
    const allLogs = await getSrsReturnLogs();
    const total = allLogs.length;

    let kept = [];
    let deletedLogs = [];

    if (explicitIds) {
      const idSet = new Set(explicitIds);
      kept = allLogs.filter((l) => !idSet.has(String(l.id)));
      deletedLogs = allLogs.filter((l) => idSet.has(String(l.id)));
    } else {
      kept = allLogs.filter((l) => !isOrphan(l));
      deletedLogs = allLogs.filter(isOrphan);
    }

    if (!dryRun && deletedLogs.length > 0) {
      await saveSrsReturnLogs(kept);
    }

    return res.status(200).json({
      success: true,
      dryRun,
      total,
      orphanCount: deletedLogs.length,
      deleted: dryRun ? 0 : deletedLogs.length,
      kept: kept.length,
      deletedPreview: deletedLogs.slice(0, 20).map((l) => ({
        id: l.id,
        createdAt: l.createdAt,
        store: l.store,
        customerName: l.customerName,
        customerEmail: l.customerEmail,
        refundAmount: Number(l.refundAmount || 0)
      }))
    });
  } catch (error) {
    console.error('[return-logs/delete-orphans] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Cleanup mislukt.' });
  }
}
