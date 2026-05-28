/**
 * /api/admin/brandbook
 *
 * Geeft de gestructureerde GENTS-brandbook terug voor de Merk-assets-pagina.
 * De beeld-assets (logo's + voorbeeldfoto's) staan als brand-*.jpg/png in de
 * Shopify-theme; de frontend zet `file` om naar een asset-URL.
 *
 * Auth: admin-token vereist.
 */

import { BRANDBOOK } from '../../lib/brandbook.js';
import { corsJson, requireAdmin } from '../../lib/request-guards.js';

export default async function handler(req, res) {
  if (corsJson(req, res, ['GET', 'OPTIONS'])) return;
  if (!requireAdmin(req, res)) return;
  return res.status(200).json({ success: true, brandbook: BRANDBOOK });
}
