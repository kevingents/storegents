import { handleCors, setCorsHeaders, isAdminRequest } from '../../lib/cors.js';
import {
  getAllFeatureFlags,
  setFeatureFlag,
  bulkSetFeatureFlags
} from '../../lib/feature-flags-store.js';

/**
 * Admin endpoint voor feature flags.
 *
 *  GET  /api/admin/feature-flags
 *     -> { success, flags: { suitconcer: {enabled, updatedAt, ...}, ... } }
 *
 *  POST /api/admin/feature-flags
 *     Body: { key, enabled }                    -> single update
 *     Body: { updates: { key1: bool, ... } }    -> bulk update
 *
 * Public listing voor de frontend om te checken welke features aan staan
 * is óók via GET /api/feature-flags (open endpoint, geen admin token) —
 * zie api/feature-flags.js. Dit endpoint hier is alleen voor admin-UI
 * en toont ook updatedAt/updatedBy metadata.
 */

function field(value) {
  if (Array.isArray(value)) return value[0] || '';
  return value || '';
}

export default async function handler(req, res) {
  if (handleCors(req, res, ['GET', 'POST', 'OPTIONS'])) return;
  setCorsHeaders(res, ['GET', 'POST', 'OPTIONS']);
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (!isAdminRequest(req)) {
    return res.status(401).json({ success: false, message: 'Niet bevoegd.' });
  }

  if (req.method === 'GET') {
    try {
      const flags = await getAllFeatureFlags();
      return res.status(200).json({
        success: true,
        flags,
        known: [
          { key: 'suitconcer', label: 'Suitconcer B2B', description: 'B2B verkoop-filiaal 702 + magazijn 704. Eigen voorraad, artikelen en orders.' }
        ]
      });
    } catch (error) {
      console.error('[admin/feature-flags] GET error:', error);
      return res.status(500).json({ success: false, message: error.message || 'Kon flags niet ophalen.' });
    }
  }

  if (req.method === 'POST') {
    try {
      const body = req.body || {};
      const updatedBy = String(field(body.updatedBy) || 'admin').trim();

      if (body.updates && typeof body.updates === 'object') {
        const result = await bulkSetFeatureFlags(body.updates, updatedBy);
        return res.status(200).json({ success: true, message: `${result.count} flags bijgewerkt.`, ...result });
      }

      const key = String(field(body.key) || '').trim();
      if (!key) return res.status(400).json({ success: false, message: 'Flag key ontbreekt.' });

      const enabled = body.enabled === true || body.enabled === 'true' || body.enabled === 1;
      const result = await setFeatureFlag(key, enabled, updatedBy);
      return res.status(200).json({
        success: true,
        message: `Flag "${key}" is nu ${enabled ? 'aan' : 'uit'}.`,
        ...result
      });
    } catch (error) {
      console.error('[admin/feature-flags] POST error:', error);
      return res.status(400).json({ success: false, message: error.message || 'Kon flag niet opslaan.' });
    }
  }

  return res.status(405).json({ success: false, message: 'Alleen GET en POST.' });
}
