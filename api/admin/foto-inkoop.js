/**
 * /api/admin/foto-inkoop
 *
 * Foto-werklijst uit de inkooporders: per ingekocht product of het al
 * gefotografeerd is (op Shopify met beeld), nog moet, of nog niet eens op
 * Shopify staat. Live (SRS PurchaseOrders ⋈ Shopify-cache).
 *
 *   GET ?days=60  → venster in dagen (7–365, default 60).
 *
 * Auth: admin-token vereist.
 */

import { buildPhotoTodo } from '../../lib/foto-inkoop.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export const maxDuration = 60;

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;

  try {
    const days = parseInt(req.query?.days, 10) || 60;
    const data = await buildPhotoTodo({ days });
    return res.status(200).json({ success: true, ...data });
  } catch (e) {
    console.error('[admin/foto-inkoop]', e);
    return res.status(500).json({ success: false, message: e.message || 'Onbekende fout.' });
  }
}
