import { handleCors, setCorsHeaders, requireAdmin } from '../../../lib/cors.js';
import { getSrsReturnLogs, saveSrsReturnLogs } from '../../../lib/srs-return-log-store.js';

/**
 * POST /api/admin/return-logs/update
 *
 * Update een bestaande retour-log met:
 *   - orderNr / shopifyOrderId (uit auto-link suggestie)
 *   - Eventueel andere meta (customerName, customerEmail, reason, etc.)
 *
 * Body: {
 *   logId: '1747...',
 *   orderNr: '33584',            // optioneel
 *   shopifyOrderId: '5234567',   // optioneel
 *   customerEmail?: '...',
 *   customerName?: '...',
 *   reason?: '...',
 *   note?: 'Handmatig gekoppeld door admin'
 * }
 */

function clean(v) { return String(v || '').trim(); }

export default async function handler(req, res) {
  if (handleCors(req, res, ['POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'Alleen POST.' });
  if (requireAdmin(req, res)) return;

  const body = req.body || {};
  const logId = clean(body.logId);
  if (!logId) return res.status(400).json({ success: false, message: 'logId ontbreekt.' });

  try {
    const logs = await getSrsReturnLogs();
    const idx = logs.findIndex((l) => String(l.id) === logId);
    if (idx === -1) return res.status(404).json({ success: false, message: `Retour-log ${logId} niet gevonden.` });

    const log = logs[idx];
    const updates = {};

    /* Alleen meegegeven velden updaten — niet-meegegeven blijven onverbroken */
    if (body.orderNr !== undefined) updates.orderNr = clean(body.orderNr).replace(/^#/, '');
    if (body.shopifyOrderId !== undefined) updates.shopifyOrderId = clean(body.shopifyOrderId);
    if (body.customerEmail !== undefined) updates.customerEmail = clean(body.customerEmail).toLowerCase();
    if (body.customerName !== undefined) updates.customerName = clean(body.customerName);
    if (body.customerId !== undefined) updates.customerId = clean(body.customerId);
    if (body.reason !== undefined) updates.reason = clean(body.reason);
    if (body.message !== undefined) updates.message = clean(body.message);

    if (!Object.keys(updates).length) {
      return res.status(400).json({ success: false, message: 'Geen velden meegegeven om te updaten.' });
    }

    const audit = {
      updatedAt: new Date().toISOString(),
      updatedBy: clean(body.updatedBy) || 'admin',
      note: clean(body.note) || 'Handmatig bijgewerkt'
    };

    logs[idx] = {
      ...log,
      ...updates,
      _lastManualUpdate: audit
    };

    await saveSrsReturnLogs(logs);

    return res.status(200).json({
      success: true,
      logId,
      updates,
      audit,
      log: logs[idx]
    });
  } catch (error) {
    console.error('[return-logs/update] error:', error);
    return res.status(500).json({ success: false, message: error.message || 'Update mislukt.' });
  }
}
